/**
 * Byte-range responses for the demo reel videos. Static assets are served
 * whole, and Safari on iPhone won't play an MP4 unless the server answers
 * Range requests, so the worker slices those files itself (they're a few MB).
 */
export const RANGED_RE = /\.mp4$/;

/** Parses a single `bytes=` range. Null means serve the whole file; "bad" means 416. */
export function byteRange(header: string | null, size: number): { start: number; end: number } | "bad" | null {
  const m = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null; // absent, multi-range or another unit: whole file is a valid answer
  const [, a, b] = m;
  if (!a && !b) return "bad";
  let start: number, end: number;
  if (!a) {
    // The last N bytes.
    start = Math.max(0, size - Number(b));
    end = size - 1;
  } else {
    start = Number(a);
    end = b ? Math.min(Number(b), size - 1) : size - 1;
  }
  if (start >= size || start > end) return "bad";
  return { start, end };
}

export async function withRanges(req: Request, assets: { fetch(req: Request): Promise<Response> }): Promise<Response> {
  const url = new URL(req.url);
  const res = await assets.fetch(new Request(url, { headers: { "if-none-match": req.headers.get("if-none-match") ?? "" } }));
  if (res.status !== 200) return res;
  const headers = new Headers(res.headers);
  headers.set("accept-ranges", "bytes");
  const body = await res.arrayBuffer();
  const size = body.byteLength;
  const range = byteRange(req.headers.get("range"), size);
  const head = req.method === "HEAD";
  if (range === "bad") {
    headers.set("content-range", `bytes */${size}`);
    headers.delete("content-length");
    return new Response(null, { status: 416, headers });
  }
  if (!range) {
    headers.set("content-length", String(size));
    return new Response(head ? null : body, { status: 200, headers });
  }
  headers.set("content-range", `bytes ${range.start}-${range.end}/${size}`);
  headers.set("content-length", String(range.end - range.start + 1));
  return new Response(head ? null : body.slice(range.start, range.end + 1), { status: 206, headers });
}
