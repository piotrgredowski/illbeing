import { afterEach, expect, mock, test } from "bun:test";
import { LocalApiRatingsAdapter } from "../../src/data/adapters/localApi";

afterEach(() => {
  mock.restore();
});

test("LocalApiRatingsAdapter maps requests correctly", async () => {
  const fetchMock = mock(async (input: string | URL | Request) => {
    const url = String(input);

    if (url.endsWith("/api/health")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    if (url.includes("/api/ratings?") && url.includes("from=") && url.includes("to=")) {
      return new Response(
        JSON.stringify({
          items: [{ timestamp: "2026-02-23T00:00:00.000Z", rating: 7 }],
        }),
        { status: 200 },
      );
    }

    if (url.endsWith("/api/ratings")) {
      return new Response(null, { status: 201 });
    }

    return new Response(null, { status: 404 });
  });

  globalThis.fetch = fetchMock as typeof fetch;

  const adapter = new LocalApiRatingsAdapter({ baseUrl: "http://localhost:8787" });
  await adapter.init();

  await adapter.appendRating({
    timestamp: "2026-02-23T00:00:00.000Z",
    rating: 7,
  });

  const rows = await adapter.listRatings({
    fromIso: "2026-02-17T00:00:00.000Z",
    toIso: "2026-02-23T23:59:59.999Z",
  });

  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual({ timestamp: "2026-02-23T00:00:00.000Z", rating: 7 });
  expect(fetchMock).toHaveBeenCalledTimes(3);
});
