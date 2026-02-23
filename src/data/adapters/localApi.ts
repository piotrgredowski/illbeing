import type { AuthState, RatingEntry, RatingsRange, RatingsStoreAdapter } from "../types";

type LocalApiAdapterOptions = {
  baseUrl: string;
};

export class LocalApiRatingsAdapter implements RatingsStoreAdapter {
  private readonly baseUrl: string;
  private ready = false;
  private authState: AuthState = "initializing";

  constructor(options: LocalApiAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
  }

  async init(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/health`);
    if (!response.ok) {
      throw new Error(`Local API health check failed: ${response.status}`);
    }

    this.ready = true;
    this.authState = "connected";
  }

  async appendRating(entry: RatingEntry): Promise<void> {
    this.assertReady();

    const response = await fetch(`${this.baseUrl}/api/ratings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(entry),
    });

    if (!response.ok) {
      throw new Error(`Failed to append rating: ${response.status}`);
    }
  }

  async listRatings(range: RatingsRange): Promise<RatingEntry[]> {
    this.assertReady();

    const query = new URLSearchParams({
      from: range.fromIso,
      to: range.toIso,
    });

    const response = await fetch(`${this.baseUrl}/api/ratings?${query.toString()}`);
    if (!response.ok) {
      throw new Error(`Failed to list ratings: ${response.status}`);
    }

    const payload = (await response.json()) as { items?: RatingEntry[] };
    return payload.items ?? [];
  }

  isReady(): boolean {
    return this.ready;
  }

  getAuthState(): AuthState {
    return this.authState;
  }

  private assertReady(): void {
    if (!this.ready) {
      throw new Error("Adapter not ready");
    }
  }
}
