require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar } = require("tough-cookie");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

// ===============================
// Supabase
// ===============================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ===============================
// Middleware
// ===============================
const allowedOrigins = (process.env.FRONTEND_URL || "")
  .split(",")
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // allow server-to-server (cron, curl, supabase, etc.)
    if (!origin) return callback(null, true);

    // allow only whitelisted frontend origins
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST"]
}));

// ===============================
// Fetch NSE Indices
// ===============================
async function fetchNSE() {
  const jar = new CookieJar();
  const client = wrapper(axios.create({ jar }));

  const BASE_URL = "https://www.nseindia.com";
  const MARKET_PAGE = "https://www.nseindia.com/market-data/live-market-indices";
  const API_URL = "https://www.nseindia.com/api/allIndices";

  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Host": "www.nseindia.com",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1"
  };

  try {
    console.log("🔍 Fetching BASE_URL...");
    await client.get(BASE_URL, { headers });

    console.log("🔍 Fetching MARKET_PAGE...");
    await client.get(MARKET_PAGE, {
      headers: {
        ...headers,
        Referer: BASE_URL,
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document"
      }
    });

    await new Promise(r => setTimeout(r, 2000));

    console.log("🔍 Fetching API_URL...");
    const res = await client.get(API_URL, {
      headers: {
        ...headers,
        Referer: MARKET_PAGE,
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty"
      }
    });

    const output = [];

    res.data.data.forEach((d) => {
      if (
        d.indexSymbol === "NIFTY 50" ||
        d.indexSymbol === "NIFTY MIDCAP 100" ||
        d.indexSymbol === "NIFTY SMLCAP 250"
      ) {
        output.push({
          stock_name: d.index,
          symbol: d.indexSymbol,
          cmp: d.last,
          lcp: d.previousClose
        });
      }
    });

    console.log("✅ NSE Data:", output.length);
    return output;

  } catch (err) {
    console.error("❌ NSE Fetch Error:", err.message);
    return [];
  }
}

// ===============================
// Fetch SENSEX (BSE)
async function fetchSensex() {
  try {
    const url = "https://query1.finance.yahoo.com/v8/finance/chart/^BSESN";

    const res = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    const result = res.data?.chart?.result?.[0];

    if (!result) {
      console.log("⚠️ No SENSEX data");
      return null;
    }

    const meta = result.meta;

    const cmp = meta.regularMarketPrice;
    const lcp = meta.previousClose;

    if (!cmp || !lcp) {
      console.log("⚠️ Invalid SENSEX values");
      return null;
    }

    console.log("✅ SENSEX fetched:", cmp);

    return {
      stock_name: "SENSEX",
      symbol: "SENSEX",
      cmp,
      lcp
    };

  } catch (err) {
    console.error("❌ SENSEX Fetch Error:", err.message);
    return null;
  }
}
// ===============================
// Insert into Supabase
// ===============================
async function insertIntoDB(data) {
  if (!data.length) return;

  const { error } = await supabase
    .from("market_indices")
    .upsert(data, { onConflict: ["symbol"] });

  if (error) {
    console.error("❌ Supabase Error:", error.message);
  } else {
    console.log("✅ DB Updated:", data.length);
  }
}

// ===============================
// Main Job
// ===============================
let isRunning = false;

async function runJob() {
  if (isRunning) {
    console.log("⏸ Already running...");
    return;
  }

  isRunning = true;

const istTimestamp = new Date().toISOString();

  console.log("🚀 Job started:", istTimestamp);

  try {
    const nseData = await fetchNSE();
    const sensexData = await fetchSensex();

    const nseDataSafe = Array.isArray(nseData) ? nseData : [];

    const finalData = nseDataSafe.map(item => ({
      ...item,
      updated_at: istTimestamp
    }));

    if (sensexData) {
      finalData.push({
        ...sensexData,
        updated_at: istTimestamp
      });
    }

    await insertIntoDB(finalData);

  } catch (err) {
    console.error("❌ Job failed:", err.message);

  } finally {
    isRunning = false;
  }
}

// ===============================
// Market Hours Check (IST)
// ===============================
function isMarketOpen() {
  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));

  const day = ist.getDay(); // 0 = Sunday
  const minutes = ist.getHours() * 60 + ist.getMinutes();

  return (
    day >= 1 && day <= 5 &&
    minutes >= (9 * 60 + 15) &&
    minutes <= (15 * 60 + 30)
  );
}

// ===============================
// Routes
// ===============================
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/trigger", async (req, res) => {
  if (req.query.key !== process.env.CRON_SECRET) {
    return res.status(403).send("Unauthorized");
  }

  await runJob();
  res.json({ message: "Job executed" });
});

// ===============================
// Cron Job (every 5 min)
// ===============================
cron.schedule("*/5 * * * *", () => {
  console.log("⏳ Cron fired");

  if (isMarketOpen()) {
    runJob();
  } else {
    console.log("⏸ Market closed");
  }
});

// ===============================
// Start Server
// ===============================
app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
  runJob();
});