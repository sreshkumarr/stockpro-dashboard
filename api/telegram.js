// api/telegram.js
// Vercel Serverless Function — runs on Node.js server, NO CORS issues
// Fetches t.me/s/StockPro_Online and parses all stock calls via Regex
// Called by: GET /api/telegram?page=latest  or  ?before=129984

export default async function handler(req, res) {
  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    return res.status(200).end();
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=55, stale-while-revalidate=30');

  const { before } = req.query;
  const url = before
    ? `https://t.me/s/StockPro_Online?before=${before}`
    : `https://t.me/s/StockPro_Online`;

  try {
    // Server-side fetch — no CORS restrictions
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; StockProBot/1.0)',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return res.status(502).json({ error: `Telegram returned ${response.status}` });
    }

    const html = await response.text();

    // ── REGEX PARSER ─────────────────────────────────────────
    const calls   = [];
    const results = [];
    const feed    = [];
    const seen    = new Set();

    function stripTags(s) {
      return s
        .replace(/<[^>]+>/g, ' ')
        .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&')
        .replace(/&#39;/g,"'").replace(/&nbsp;/g,' ')
        .replace(/\s+/g,' ').trim();
    }

    function cleanNum(s) {
      return parseFloat(s.toString().replace(/,/g, ''));
    }

    // Extract message blocks with timestamps
    const blockRE = /<div class="tgme_widget_message "\s+data-post="[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/gi;
    const textRE  = /class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i;
    const timeRE  = /datetime="([^"]+)"/i;
    const msgIdRE = /data-post="StockPro_Online\/(\d+)"/i;

    // Simpler approach: extract all text blocks and times together
    const allTextBlocks = [];
    const textPattern = /class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>(?=\s*<\/div>)/gi;
    const timePattern  = /datetime="([^"]+)"/gi;
    const idPattern    = /data-post="StockPro_Online\/(\d+)"/gi;

    let tm, tt, ti;
    const texts = [], times = [], ids = [];
    while ((tm = textPattern.exec(html)) !== null) texts.push(stripTags(tm[1]));
    while ((tt = timePattern.exec(html))  !== null) times.push(tt[1]);
    while ((ti = idPattern.exec(html))    !== null) ids.push(parseInt(ti[1]));

    // Parse each text block
    texts.forEach((txt, idx) => {
      const ts  = times[idx] || new Date().toISOString();
      const mid = ids[idx]   || 0;
      const date = ts.split('T')[0];

      feed.push({ text: txt.slice(0, 300), time: ts, msgId: mid });

      const isCall     = /POSITIONAL\s+TRADE|SWING\s+TRADE/i.test(txt);
      const isBreakout = /fresh\s+breakout|breakout\s+above/i.test(txt) && !/hit|made|moved/i.test(txt);
      const isWatch    = /^Watch\s+[A-Z]/i.test(txt) && /above\s+[\d]/i.test(txt);
      const isResult   = /hit.*?high|made.*?high|Upper Circuit|points done|moved up/i.test(txt);

      // ── RESULT MESSAGE ───────────────────────────────────
      if (isResult && !isCall) {
        const highM = txt.match(/(?:hit|made).*?high\s+of\s+([\d,]+\.?\d*)/i) ||
                      txt.match(/made\s+a\s+high\s+of\s+([\d,]+\.?\d*)/i);
        const pctM  = txt.match(/([\d.]+)%/);
        if (highM) {
          results.push({
            text: txt, time: ts,
            high: cleanNum(highM[1]),
            pct:  pctM ? parseFloat(pctM[1]) : null,
          });
        }
        return;
      }

      if (!isCall && !isBreakout && !isWatch) return;

      // ── CALL PARSING ─────────────────────────────────────
      let stock = '', entry = null, sl = null, targets = [], type = 'Positional', hold = 'few days';

      if (/SWING/i.test(txt))   type = 'Swing';
      if (isBreakout)            type = 'Breakout';

      // Stock name: between "TRADE" and "Looks Good ABOVE"
      const nameM = txt.match(/(?:POSITIONAL\s+TRADE|SWING\s+TRADE)\s+([A-Z][A-Z0-9\s&\.\(\)]+?)\s+(?:Looks\s+Good|ABOVE)/i);
      if (nameM) stock = nameM[1].trim().replace(/\s+/g,' ').toUpperCase();

      // Breakout: "breakout above 592 in HINDCOPPER"
      if (!stock && isBreakout) {
        const bm = txt.match(/breakout\s+above\s+[\d,]+\s+in\s+([A-Z][A-Z\s]+)/i) ||
                   txt.match(/([A-Z]{4,})\s+(?:fresh\s+)?breakout/i);
        if (bm) stock = bm[1].trim().toUpperCase();
      }

      // Watch: "Watch CAMLINFINE above 140"
      if (!stock && isWatch) {
        const wm = txt.match(/Watch\s+([A-Z][A-Z0-9\s]+?)\s+(?:above|$)/i);
        if (wm) stock = wm[1].trim().toUpperCase();
      }

      if (!stock || stock.length < 2) return;

      // Deduplicate by stock+date
      const key = stock + '_' + date;
      if (seen.has(key)) return;
      seen.add(key);

      // Entry
      const abM = txt.match(/ABOVE\s+([\d,]+\.?\d*)/i);
      if (abM) entry = cleanNum(abM[1]);

      // SL
      const slM = txt.match(/\bSL\s+([\d,]+\.?\d*)/i);
      if (slM) sl = cleanNum(slM[1]);

      // Targets — point-based ("Targets 1-2-3-4-5-6 points")
      const ptM = txt.match(/Targets?\s+([\d]+(?:\s*[-–]\s*[\d]+)+)\s*points/i);
      if (ptM && entry) {
        const pts = ptM[1].split(/\s*[-–]\s*/).map(Number).filter(n => n > 0);
        targets = pts.map(p => parseFloat((entry + p).toFixed(2)));
      } else {
        // Absolute targets ("Targets 2750-2800-2850")
        const tM = txt.match(/Targets?\s+([\d,]+\.?\d*(?:\s*[-–]\s*[\d,]+\.?\d*)+)/i);
        if (tM) {
          targets = tM[1].split(/\s*[-–]\s*/)
            .map(s => cleanNum(s))
            .filter(n => n > 0 && (!sl || n > sl));
        }
      }

      // Hold period
      const holdM = txt.match(/Hold\s+(.+?)(?:\s+Please|\s*$)/i);
      if (holdM) hold = holdM[1].trim();

      // Date referenced in message ("9th June 2026")
      const dateRefM = txt.match(/(\d+(?:th|st|nd|rd)\s+\w+\s+\d{4})/i);
      const dateCalled = dateRefM
        ? new Date(dateRefM[1]).toISOString().split('T')[0]
        : date;

      if (entry) {
        calls.push({
          stock,
          ticker:    toYahooSym(stock),
          type,
          entry,
          sl:        sl || parseFloat((entry * 0.95).toFixed(2)),
          targets:   targets.length ? targets : [parseFloat((entry * 1.03).toFixed(2))],
          hold,
          dateCalled,
          msgId:     mid,
          todayHigh: null,
          movePct:   null,
        });
      }
    });

    // ── MATCH RESULTS TO CALLS ───────────────────────────
    results.forEach(r => {
      calls.forEach(c => {
        const keywords = c.stock.split(' ').filter(k => k.length > 3);
        const matched  = keywords.some(k => r.text.toUpperCase().includes(k));
        if (matched) {
          if (!c.todayHigh || r.high > c.todayHigh) c.todayHigh = r.high;
          if (r.pct && !c.movePct) c.movePct = r.pct;
        }
      });
    });

    // ── RESPONSE ─────────────────────────────────────────
    return res.status(200).json({
      success:   true,
      fetchedAt: new Date().toISOString(),
      url,
      msgCount:  texts.length,
      callCount: calls.length,
      calls,
      feed:      feed.slice(-30),
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// Yahoo Finance symbol mapper
function toYahooSym(stock) {
  const map = {
    'ASHOKA LEYLAND':    'ASHOKLEYLAND',
    'ASHOKALEYLAND':     'ASHOKLEYLAND',
    'FEDERAL BANK':      'FEDERALBNK',
    'ASIAN PAINTS':      'ASIANPAINT',
    'HINDUSTAN COPPER':  'HINDCOPPER',
    'HINDUSTAN ZINC':    'HINDZINC',
    'IIFL FINANCE':      'IIFL',
    'POWER MECH PROJ':   'POWERMECHP',
    'PARAS DEFENCE':     'PARASDEFE',
    'PARAS':             'PARASDEFE',
    'NETWEB TECH':       'NETWEB',
    'CAMLIN FINE SCI':   'CAMLINFINE',
    'PIDILITE IND':      'PIDILITIND',
    'PIDILITE INDUSTRIES': 'PIDILITIND',
    'SASKEN':            'SASKEN',
    'SASKEN TECHNOLOGIES': 'SASKEN',
    'JINDAL DRILLING':   'JINDRILL',
    'TEXMACO':           'TEXMACO',
    'HFCL':              'HFCL',
    'HINDALCO':          'HINDALCO',
    'INNOVA CAPITAL':    'INNOVACAP',
  };
  for (const [k, v] of Object.entries(map)) {
    if (stock.includes(k)) return v;
  }
  return stock.replace(/\s+/g, '').replace(/&/g, 'AND').slice(0, 15);
}
