// fb-bot.js
import "dotenv/config";
import puppeteer from "puppeteer";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import readline from "readline";
import { Resend } from "resend";
import { OpenAI } from "openai";

// ---------- Paths ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const COOKIES_PATH = path.join(__dirname, "fb-cookies.json");
const SEEN_FILE = path.join(__dirname, "seen-fb-posts.json");

// ---------- Env / clients ----------
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const LEAD_NOTIFY_EMAIL = process.env.LEAD_NOTIFY_EMAIL || "elkhayatzack@gmail.com";
const LEAD_FROM_EMAIL =
  process.env.LEAD_FROM_EMAIL || "Pickleball & Real Estate Leads <onboarding@resend.dev>";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ---------- FB groups you want to scan ----------
const GROUP_URLS = [
  // Pickleball groups
  "https://www.facebook.com/groups/1165030964029637",
  "https://www.facebook.com/groups/ocpickleball",
  "https://www.facebook.com/groups/2670990313289380",
  "https://www.facebook.com/groups/irvinelife",

  // Local community / real estate / neighborhood groups
  "https://www.facebook.com/groups/1489929731220541",
  "https://www.facebook.com/groups/354499855042339",
  "https://www.facebook.com/groups/NewportBeachDailyPost",
  "https://www.facebook.com/groups/1649809359092008",
  "https://www.facebook.com/groups/sdbeachcities",
  "https://www.facebook.com/groups/299032211029304",
  "https://www.facebook.com/groups/2096630413981134",
  "https://www.facebook.com/groups/258031801293776",
  "https://www.facebook.com/groups/temeculatalk01",
  "https://www.facebook.com/groups/irvineresidentsconnect",
  "https://www.facebook.com/groups/irvinelife",
  "https://www.facebook.com/groups/622910064501669",
  "https://www.facebook.com/groups/ResidentsOfIrvine"
];

// ---------- Topic configs (same idea as Reddit) ----------
const TOPICS = {
  pickleball: {
    displayName: "Pickleball",
    keywords: [
      "pickleball",
      "paddle",
      "paddles",
      "court",
      "courts",
      "open play",
      "drop in",
      "clinic",
      "lessons",
      "beginner",
      "beginners",
      "round robin",
      "event",
      " looking to play"
    ]
  },

  realestate: {
    displayName: "Real Estate",
    keywords: [
      "moving to",
      "relocating to",
      "move to irvine",
      "move to oc",
      "rent in",
      "rental in",
      "apartment",
      "condo",
      "townhome",
      "townhouse",
      "buy a house",
      "buying a house",
      "home prices",
      "house prices",
      "zillow",
      "redfin",
      "realtor",
      "real estate agent",
      "mortgage",
      "pre approval",
      "down payment",
      "we are moving from",
      "looking for a small home",
      "looking for a condo",
      "looking for a home",
      "looking for a realtor",
      "does anyone know a realtor",
      "need a real estate agent"
    ]
  }
};

// ---------- Helpers for stdin (still here if you ever run locally) ----------
function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// ---------- Persistence: seen IDs ----------
async function loadSeenIds() {
  try {
    const raw = await fs.readFile(SEEN_FILE, "utf8");
    const arr = JSON.parse(raw);
    return new Set(arr);
  } catch {
    return new Set();
  }
}

async function saveSeenIds(seenSet) {
  const arr = [...seenSet];
  await fs.writeFile(SEEN_FILE, JSON.stringify(arr, null, 2), "utf8");
}

// ---------- Open / login FB (server-friendly) ----------
async function getBrowserAndPage() {
  // On the droplet we run headless with no sandbox
  const isServer = process.env.RUN_ENV === "server";

  const browser = await puppeteer.launch({
    headless: isServer ? "new" : false,
    defaultViewport: null,
    args: [
     args: [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-software-rasterizer",
  "--no-zygote",
  "--single-process",
  "--disable-extensions",
  "--disable-features=IsolateOrigins,site-per-process,Translate",
  "--disable-background-networking",
  "--disable-background-timer-throttling",
  "--disable-breakpad",
  "--disable-sync",
  "--metrics-recording-only",
  "--mute-audio"
]

    ]
  });

  const page = await browser.newPage();

  // We expect fb-cookies.json to already exist (created on your laptop).
  try {
    const cookieRaw = await fs.readFile(COOKIES_PATH, "utf8");
    const cookies = JSON.parse(cookieRaw);
    await page.setCookie(...cookies);
    console.log("🍪 Loaded saved Facebook cookies.");
  } catch (err) {
    console.error(
      "❌ fb-cookies.json not found or unreadable. " +
        "Create it on your local machine by logging in once and then copy it to the server."
    );
    await browser.close();
    throw err;
  }

  await page.goto("https://www.facebook.com", { waitUntil: "networkidle2" });
  console.log("✅ Facebook loaded with existing session cookies.");

  return { browser, page };
}

// ---------- Topic detection ----------
function detectTopics(text) {
  const t = text.toLowerCase();
  const matched = [];

  for (const [key, cfg] of Object.entries(TOPICS)) {
    const hasKeyword = cfg.keywords.some((kw) => t.includes(kw.toLowerCase()));
    if (hasKeyword) {
      matched.push(key);
    }
  }

  return matched;
}

// ---------- Suggested reply using OpenAI ----------
async function getSuggestedReply({ topicKey, text, groupUrl }) {
  if (!openai || !topicKey) {
    if (topicKey === "realestate") {
      return `Hi! I'm Zack, a local real estate agent in Irvine and surrounding areas. Happy to be a resource if you ever want to chat about neighborhoods, prices, or next steps — no pressure at all.`;
    }
    return `Hey! I'm Zack and I run Pickleball & Wellness Collective here in Irvine. If you ever want to hit, learn the game, or find local courts and meetups, I’d love to help.`;
  }

  const systemPrompt =
    topicKey === "realestate"
      ? "You are Zack, an Irvine-based real estate agent. You write short, warm, non-pushy replies that invite people to connect if they want help, but never sound like spam."
      : 'You are Zack, organizer of "Pickleball & Wellness Collective" in Irvine. You write short, warm, non-spammy replies inviting people to play or reach out.';

  const userPrompt = `
Group URL: ${groupUrl}

Post text:
"""
${text.slice(0, 1200)}
"""

Write a reply in 2–4 sentences, first person ("I"), casual but clear, and helpful.
Mention that you're local to Irvine / Orange County.
Invite them to DM or connect if they'd like more info.
Do NOT be salesy or pushy.
`;

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4.1",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    });

    return resp.choices[0].message.content.trim();
  } catch (err) {
    console.error("❌ OpenAI error:", err);
    if (topicKey === "realestate") {
      return `Hi! I'm Zack, a local agent in Irvine/OC. If you ever want a second set of eyes on neighborhoods, prices, or options, I’m happy to help — no pressure.`;
    }
    return `Hey! I'm Zack and I run a local pickleball group in Irvine. If you’d like to find courts or join a meetup, feel free to reach out.`;
  }
}

// ---------- Email summary sending ----------
async function sendSummaryEmail(topicKey, leads) {
  if (!resend) {
    console.warn("⚠ Resend not configured, skipping email for", topicKey);
    return;
  }

  if (!leads || leads.length === 0) return;

  const topic = TOPICS[topicKey];
  const label = topic?.displayName || topicKey;

  const leadsWithReplies = [];
  for (const lead of leads) {
    const suggestedReply = await getSuggestedReply({
      topicKey,
      text: lead.text,
      groupUrl: lead.groupUrl
    });
    leadsWithReplies.push({ ...lead, suggestedReply });
  }

  const subject = `NEW Facebook ${label} Leads (${leadsWithReplies.length})`;

  const htmlBlocks = leadsWithReplies
    .map((lead, idx) => {
      return `
        <h3>${idx + 1}. ${lead.groupName || "Facebook Group"}</h3>
        <p><strong>Group URL:</strong> <a href="${lead.groupUrl}" target="_blank">${lead.groupUrl}</a></p>
        <p><strong>Post snippet:</strong></p>
        <p style="white-space: pre-wrap;">${lead.text}</p>
        <p><strong>Approx link (if captured):</strong> ${
          lead.postLink
            ? `<a href="${lead.postLink}" target="_blank">${lead.postLink}</a>`
            : "(no direct link, open the group and scroll)"
        }</p>
        <p><strong>Suggested reply:</strong></p>
        <p style="white-space: pre-wrap;">${lead.suggestedReply}</p>
        <hr/>
      `;
    })
    .join("\n");

  const html = `
    <h2>Facebook ${label} Leads Summary</h2>
    <p>Found ${leadsWithReplies.length} potential leads across your groups.</p>
    <hr/>
    ${htmlBlocks}
  `;

  const textBlocks = leadsWithReplies
    .map((lead, idx) => {
      return `
${idx + 1}. ${lead.groupName || "Facebook Group"}
Group URL: ${lead.groupUrl}
Post snippet:
${lead.text}

Post link (if captured): ${lead.postLink || "open group and scroll"}

Suggested reply:
${lead.suggestedReply}
`;
    })
    .join("\n-----------------------------\n");

  const text = `
Facebook ${label} Leads Summary
Found ${leadsWithReplies.length} potential leads.

${textBlocks}
`.trim();

  const res = await resend.emails.send({
    from: LEAD_FROM_EMAIL,
    to: LEAD_NOTIFY_EMAIL,
    subject,
    html,
    text
  });

  console.log(`📧 ${label} summary email SUCCESS:`, res?.data?.id || res);
}

// ---------- Scrape one group ----------
async function scrapeGroup(page, groupUrl, seenIds, leadsByTopic, { deepScan = false } = {}) {
  console.log(`\n📂 Visiting group: ${groupUrl}`);

  await page.goto(groupUrl, { waitUntil: "networkidle2" });

  const scrollRounds = deepScan ? 10 : 3;

  for (let i = 0; i < scrollRounds; i++) {
    await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight);
    });
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  const posts = await page.evaluate((deep) => {
    const articles = Array.from(document.querySelectorAll('[role="article"]'));
    const maxPosts = deep ? 60 : 15;

    return articles.slice(0, maxPosts).map((el, idx) => {
      const text = (el.innerText || "").trim();

      let link = null;
      const linkEl =
        el.querySelector('a[href*="/posts/"]') ||
        el.querySelector('a[href*="permalink"]') ||
        el.querySelector('a[href*="/groups/"]');

      if (linkEl && linkEl.href) {
        link = linkEl.href;
      }

      const keyBase = text.slice(0, 80).replace(/\s+/g, " ").trim();
      const pseudoId = `${keyBase}::${idx}`;

      return {
        pseudoId,
        text,
        postLink: link
      };
    });
  }, deepScan);

  console.log(`📝 Found ${posts.length} articles in this group.`);

  for (const post of posts) {
    if (!post.text) continue;

    const globalId = `${groupUrl}::${post.pseudoId}`;

    if (seenIds.has(globalId)) continue;

    const topics = detectTopics(post.text);

    if (topics.length > 0) {
      console.log(
        `🎯 FB LEAD DETECTED [${topics
          .map((t) => TOPICS[t]?.displayName || t)
          .join(", ")}] in group ${groupUrl}`
      );

      for (const t of topics) {
        if (!leadsByTopic[t]) leadsByTopic[t] = [];
        leadsByTopic[t].push({
          groupUrl,
          groupName: null,
          text: post.text,
          postLink: post.postLink
        });
      }
    }

    seenIds.add(globalId);
  }
}

// ---------- Main ----------
async function main() {
  console.log("🤖 Facebook Groups bot starting (headless on server)…");

  let isFirstRun = false;
  try {
    await fs.access(SEEN_FILE);
  } catch {
    isFirstRun = true;
    console.log("✨ First run detected: doing a deeper initial scan.");
  }

  const seenIds = await loadSeenIds();
  const leadsByTopic = {
    pickleball: [],
    realestate: []
  };

  const { browser, page } = await getBrowserAndPage();

  try {
    for (const groupUrl of GROUP_URLS) {
      try {
        await scrapeGroup(page, groupUrl, seenIds, leadsByTopic, {
          deepScan: isFirstRun
        });
      } catch (err) {
        console.error("❌ Error scraping group:", groupUrl, err);
      }
    }
  } finally {
    await browser.close();
  }

  if (leadsByTopic.pickleball.length > 0) {
    await sendSummaryEmail("pickleball", leadsByTopic.pickleball);
  } else {
    console.log("✅ No new pickleball leads this run.");
  }

  if (leadsByTopic.realestate.length > 0) {
    await sendSummaryEmail("realestate", leadsByTopic.realestate);
  } else {
    console.log("✅ No new real estate leads this run.");
  }

  await saveSeenIds(seenIds);
  console.log("✅ FB bot run complete.");
}

main().catch((err) => {
  console.error("❌ Fatal FB bot error:", err);
  process.exit(1);
});

