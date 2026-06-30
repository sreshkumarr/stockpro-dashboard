// api/nse.js
// Vercel Serverless Function — fetches Yahoo Finance .NS prices server-side
// Called by: GET /api/nse?symbols=ASHOKLEYLAND,PARASDEFE,NETWEB

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).end();
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=55, stale-while-revalidate=30');

  const { symbols } = req.query;
  if (!symbols) return res.status(400).json({ error: 'symbols param required' });

  const symList = symbols.split(',').map(s => s.trim()).filter(Boolean).slice(0, 20);
  const prices  = {};

  await Promise.all(symList.map(async sym => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}.NS?interval=1m&range=1d`;
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      const meta = json?.chart?.result?.[0]?.meta;
      if (meta?.regularMarketPrice) {
        prices[sym] = {
          price:  meta.regularMarketPrice,
          open:   meta.regularMarketOpen   || null,
          high:   meta.regularMarketDayHigh|| null,
          low:    meta.regularMarketDayLow || null,
          prev:   meta.chartPreviousClose  || null,
          change: meta.regularMarketPrice - (meta.chartPreviousClose || meta.regularMarketPrice),
          pct:    ((meta.regularMarketPrice - (meta.chartPreviousClose||meta.regularMarketPrice)) / (meta.chartPreviousClose||meta.regularMarketPrice) * 100),
          source: 'live',
          sym,
        };
      }
    } catch (e) {
      prices[sym] = { error: e.message, source: 'failed', sym };
    }
  }));

  return res.status(200).json({
    success:   true,
    fetchedAt: new Date().toISOString(),
    count:     Object.keys(prices).length,
    prices,
  });
}
