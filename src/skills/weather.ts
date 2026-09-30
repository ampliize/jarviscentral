/**
 * Clima pela Open-Meteo (gratuita, sem chave). Guarda a localização das
 * cidades e a previsão por 10 minutos para responder rápido.
 */
const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const TTL_MS = 10 * 60 * 1000;

/** Códigos WMO → descrição em português. */
const WMO: Record<number, string> = {
  0: "céu limpo",
  1: "poucas nuvens",
  2: "parcialmente nublado",
  3: "nublado",
  45: "neblina",
  48: "neblina",
  51: "garoa fraca",
  53: "garoa",
  55: "garoa forte",
  56: "garoa gelada",
  57: "garoa gelada",
  61: "chuva fraca",
  63: "chuva",
  65: "chuva forte",
  66: "chuva gelada",
  67: "chuva gelada",
  71: "neve fraca",
  73: "neve",
  75: "neve forte",
  77: "neve",
  80: "pancadas de chuva fracas",
  81: "pancadas de chuva",
  82: "pancadas de chuva fortes",
  85: "neve",
  86: "neve",
  95: "trovoadas",
  96: "trovoadas com granizo",
  99: "trovoadas com granizo",
};

export interface Weather {
  cidade: string;
  agora: { temperatura: number; sensacao: number | null; umidade: number | null; condicao: string };
  hoje: { minima: number | null; maxima: number | null; chance_de_chuva: number | null };
  amanha: { minima: number | null; maxima: number | null; chance_de_chuva: number | null; condicao: string } | null;
}

export class WeatherError extends Error {}

/** Número arredondado, ou null quando o serviço não mandou o valor (nunca vira 0°). */
const num = (v: unknown) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));

export class WeatherService {
  private places = new Map<string, { name: string; lat: number; lon: number }>();
  private cache = new Map<string, { at: number; data: Weather }>();

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private async getJson(url: string) {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { signal: AbortSignal.timeout(8_000) });
    } catch {
      throw new WeatherError("O serviço de clima não respondeu.");
    }
    if (!res.ok) throw new WeatherError(`O serviço de clima falhou (HTTP ${res.status}).`);
    return res.json() as Promise<Record<string, unknown>>;
  }

  private async place(city: string) {
    const key = city.trim().toLowerCase();
    const known = this.places.get(key);
    if (known) return known;
    const url = `${GEO_URL}?name=${encodeURIComponent(city.trim())}&count=1&language=pt&format=json`;
    const data = await this.getJson(url);
    const first = (data.results as { name: string; admin1?: string; latitude: number; longitude: number }[] | undefined)?.[0];
    if (!first) throw new WeatherError(`Não encontrei a cidade "${city}".`);
    const place = { name: first.admin1 ? `${first.name} (${first.admin1})` : first.name, lat: first.latitude, lon: first.longitude };
    this.places.set(key, place);
    return place;
  }

  async get(city: string): Promise<Weather> {
    const key = city.trim().toLowerCase();
    if (!key) throw new WeatherError("Informe a cidade.");
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
    const p = await this.place(city);
    const url =
      `${FORECAST_URL}?latitude=${p.lat}&longitude=${p.lon}` +
      "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code" +
      "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code" +
      // "auto": hoje/amanhã no fuso da cidade consultada (Lisboa, Aracaju...).
      "&timezone=auto&forecast_days=2";
    const f = await this.getJson(url);
    const cur = f.current as Record<string, number | null> | undefined;
    const daily = (f.daily ?? {}) as Record<string, (number | null)[] | undefined>;
    const temperatura = num(cur?.temperature_2m);
    if (!cur || temperatura == null) throw new WeatherError("Resposta de clima incompleta.");
    const day = (i: number) => ({
      minima: num(daily.temperature_2m_min?.[i]),
      maxima: num(daily.temperature_2m_max?.[i]),
      chance_de_chuva: num(daily.precipitation_probability_max?.[i]),
    });
    const tomorrow = day(1);
    const data: Weather = {
      cidade: p.name,
      agora: {
        temperatura,
        sensacao: num(cur.apparent_temperature),
        umidade: num(cur.relative_humidity_2m),
        condicao: WMO[Number(cur.weather_code)] ?? "tempo indefinido",
      },
      hoje: day(0),
      amanha:
        tomorrow.minima != null && tomorrow.maxima != null
          ? { ...tomorrow, condicao: WMO[Number(daily.weather_code?.[1])] ?? "tempo indefinido" }
          : null,
    };
    this.cache.set(key, { at: Date.now(), data });
    return data;
  }
}
