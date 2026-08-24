// scripts/news-bot.js
import fetch from 'node-fetch';
import { parseStringPromise } from 'xml2js';

// ══════════════════════════════════════════════
//  設定
// ══════════════════════════════════════════════
const CONFIG = {
  MODEL: 'gemini-2.5-flash',
  // gemini-2.5-flash 無料枠: 500回/日, 10回/分
  // 1記事1回 × 15件 = 15回/実行 → 1日2回 = 30回 → 余裕あり
  MAX_ARTICLES: 15,
  // Geminiに渡す候補数（多すぎるとトークン超過・品質低下）
  CANDIDATE_COUNT: 20,
  // リトライ上限（クォータ無関係のエラー用）
  MAX_RETRIES: 3,
  // レート制限時のデフォルト待機時間（秒）
  DEFAULT_RATE_LIMIT_WAIT: 30,
  RSS_FEEDS: [
    { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', source: 'BBC News' },
    { url: 'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml', source: 'BBC Entertainment' },
    { url: 'https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml', source: 'BBC US & Canada' },
    { url: 'https://feeds.bbci.co.uk/news/business/rss.xml', source: 'BBC Business' },
    { url: 'https://feeds.bbci.co.uk/news/technology/rss.xml', source: 'BBC Technology' },
    { url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml', source: 'BBC Science' },
    { url: 'https://feeds.bbci.co.uk/news/health/rss.xml', source: 'BBC Health' },
    { url: 'https://www.theguardian.com/world/rss', source: 'The Guardian' },
    { url: 'https://www.theguardian.com/us-news/rss', source: 'The Guardian US' },
    { url: 'https://www.theguardian.com/technology/rss', source: 'The Guardian Tech' },
    { url: 'https://www.theguardian.com/culture/rss', source: 'The Guardian Culture' },
    { url: 'https://www.aljazeera.com/xml/rss/all.xml', source: 'Al Jazeera' },
    { url: 'https://feeds.nbcnews.com/nbcnews/public/news', source: 'NBC News' },
    { url: 'https://feeds.abcnews.com/abcnews/topstories', source: 'ABC News' },
    { url: 'https://www.euronews.com/rss', source: 'Euronews' },
    { url: 'https://news.google.com/rss/search?q=weird+strange+unusual+news&hl=en-US&gl=US&ceid=US:en', source: 'Google News' },
    { url: 'https://news.google.com/rss/search?q=celebrity+youtuber+influencer+news&hl=en-US&gl=US&ceid=US:en', source: 'Google News' },
    { url: 'https://news.google.com/rss/search?q=politics+scandal+controversy&hl=en-US&gl=US&ceid=US:en', source: 'Google News' },
    { url: 'https://news.google.com/rss/search?q=viral+social+media+news&hl=en-US&gl=US&ceid=US:en', source: 'Google News' },
    { url: 'https://news.google.com/rss/search?q=interesting+world+news&hl=en-US&gl=US&ceid=US:en', source: 'Google News' },
  ]
};

// ══════════════════════════════════════════════
//  環境変数
// ══════════════════════════════════════════════
const FIREBASE_DB_URL  = process.env.FIREBASE_DB_URL;
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const GEMINI_API_KEY   = process.env.GEMINI_API_KEY;
const NEWSBOT_EMAIL    = process.env.NEWSBOT_EMAIL;
const NEWSBOT_PASSWORD = process.env.NEWSBOT_PASSWORD;
const NEWSBOT_UID      = process.env.NEWSBOT_UID;

for (const [k, v] of Object.entries({ FIREBASE_DB_URL, FIREBASE_API_KEY, GEMINI_API_KEY, NEWSBOT_EMAIL, NEWSBOT_PASSWORD, NEWSBOT_UID })) {
  if (!v) throw new Error(`環境変数 ${k} が設定されていません`);
}

// ══════════════════════════════════════════════
//  Gemini APIエラー解析
// ══════════════════════════════════════════════
function analyzeGeminiError(status, body) {
  /*
   * 戻り値:
   *   { type: 'DAILY_QUOTA', wait: null }   → 日次クォータ超過 → 即終了
   *   { type: 'RATE_LIMIT',  wait: 秒数 }   → 短時間レート制限 → 待機後リトライ
   *   { type: 'OTHER',       wait: null }   → その他エラー → 通常リトライ
   */
  const err = body?.error;
  const msg = err?.message || '';
  const code = err?.code;

  // retryDelay があれば取得
  let retryDelaySec = null;
  const retryInfo = err?.details?.find(d => d['@type']?.includes('RetryInfo'));
  if (retryInfo?.retryDelay) {
    const match = String(retryInfo.retryDelay).match(/(\d+)/);
    if (match) retryDelaySec = parseInt(match[1], 10);
  }

  // quotaId で日次クォータかレート制限かを判定
  const quotaId = err?.details
    ?.find(d => d['@type']?.includes('QuotaFailure'))
    ?.violations?.[0]?.quotaId || '';

  const isDailyQuota = quotaId.includes('PerDay') || quotaId.includes('Daily');
  const isRateLimit  = quotaId.includes('PerMinute') || quotaId.includes('PerSecond')
                     || (!isDailyQuota && status === 429);

  console.error(`  [Gemini Error] HTTPステータス: ${status}`);
  console.error(`  [Gemini Error] コード: ${code}`);
  console.error(`  [Gemini Error] メッセージ: ${msg.slice(0, 200)}`);
  console.error(`  [Gemini Error] quotaId: ${quotaId || '不明'}`);
  if (retryDelaySec !== null) console.error(`  [Gemini Error] retryDelay: ${retryDelaySec}秒`);

  if (isDailyQuota) {
    console.error('  [判定] 日次クォータ超過 → 処理終了');
    return { type: 'DAILY_QUOTA', wait: null };
  }
  if (isRateLimit) {
    const wait = retryDelaySec ?? CONFIG.DEFAULT_RATE_LIMIT_WAIT;
    console.error(`  [判定] 短時間レート制限 → ${wait}秒待機後リトライ`);
    return { type: 'RATE_LIMIT', wait };
  }
  console.error('  [判定] その他エラー → 通常リトライ');
  return { type: 'OTHER', wait: null };
}

// ══════════════════════════════════════════════
//  Firebase Auth
// ══════════════════════════════════════════════
async function getFirebaseToken() {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: NEWSBOT_EMAIL, password: NEWSBOT_PASSWORD, returnSecureToken: true })
    }
  );
  const data = await res.json();
  if (!data.idToken) throw new Error('Firebase Auth失敗: ' + (data.error?.message || JSON.stringify(data)));
  console.log('✅ Firebase Auth成功');
  return data.idToken;
}

// ══════════════════════════════════════════════
//  既存記事取得
// ══════════════════════════════════════════════
async function getExistingArticles(token) {
  const res = await fetch(`${FIREBASE_DB_URL}/newsArticles.json?auth=${token}`);
  if (!res.ok) throw new Error(`既存記事取得失敗: HTTP ${res.status}`);
  const data = await res.json();
  return data ? Object.values(data) : [];
}

// ══════════════════════════════════════════════
//  既存スレッド全削除
// ══════════════════════════════════════════════
async function clearAllThreads(token) {
  console.log('🗑️ 既存スレッドを全削除中...');
  const res = await fetch(`${FIREBASE_DB_URL}/threads.json?auth=${token}`);
  const threads = await res.json();
  if (threads && typeof threads === 'object') {
    for (const tid of Object.keys(threads)) {
      await fetch(`${FIREBASE_DB_URL}/posts/${tid}.json?auth=${token}`, { method: 'DELETE' });
      await fetch(`${FIREBASE_DB_URL}/threads/${tid}.json?auth=${token}`, { method: 'DELETE' });
    }
  }
  await fetch(`${FIREBASE_DB_URL}/newsArticles.json?auth=${token}`, { method: 'DELETE' });
  console.log('✅ 全削除完了');
}

// ══════════════════════════════════════════════
//  RSS取得
// ══════════════════════════════════════════════
async function fetchRSS(feed) {
  try {
    const res = await fetch(feed.url, { headers: { 'User-Agent': 'EcstasyNewsBot/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const parsed = await parseStringPromise(xml, { explicitArray: false });
    const channel = parsed.rss?.channel;
    if (!channel) throw new Error('RSSパース失敗');
    const rawItems = channel.item;
    const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];
    return items.map(item => {
      const url = typeof item.link === 'string' ? item.link : item.link?._ || '';
      const description = typeof item.description === 'string' ? item.description : item.description?._ || '';
      return { title: item.title || '', url, description: description.slice(0, 150), source: feed.source };
    }).filter(a => a.title && a.url);
  } catch (e) {
    console.error(`❌ ${feed.source} 取得失敗: ${e.message}`);
    return [];
  }
}

// ══════════════════════════════════════════════
//  Geminiで記事を1件生成
// ══════════════════════════════════════════════
async function generateOneArticle(candidates, usedUrls, usedTitles) {
  // 未使用の候補からランダムにCANDIDATE_COUNT件選ぶ
  const unused = candidates.filter(c => !usedUrls.has(c.url));
  if (!unused.length) return { result: null, quota: 'OK' };
  const sample = unused.sort(() => Math.random() - 0.5).slice(0, CONFIG.CANDIDATE_COUNT);

  const candidateText = sample.map((a, i) =>
    `[${i + 1}] ${a.source}: ${a.title} | ${a.description}`
  ).join('\n');

  const prompt = `以下のニュース候補から1つ選んで日本語記事を生成してください。

過去に使ったタイトル（重複禁止）:
${[...usedTitles].slice(-20).join('\n')}

候補:
${candidateText}

以下のJSON形式のみで回答（前置き・コードブロック不要）:
{"title":"タイトル","summary":"200〜400文字の本文","category":"カテゴリ","country":"国名（日本語）","lat":35.7,"lng":139.7,"sourceIndex":1}

categoryは「海外事件」「海外ニュース」「政治・社会」「芸能」「スキャンダル」「雑学」「その他」のいずれか。
sourceIndexは選んだ候補の番号(1〜${sample.length})。`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.8, maxOutputTokens: 800 }
      })
    }
  );

  const body = await res.json();

  // エラー処理
  if (!res.ok) {
    const analysis = analyzeGeminiError(res.status, body);
    return { result: null, quota: analysis.type, wait: analysis.wait };
  }

  const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    console.error('⚠️ Geminiから空のレスポンス');
    return { result: null, quota: 'OK' };
  }

  // JSON抽出
  let cleaned = text.trim();
  const first = cleaned.indexOf('{');
  const last  = cleaned.lastIndexOf('}');
  if (first === -1 || last === -1) {
    console.error('⚠️ JSONが見つからない:', cleaned.slice(0, 100));
    return { result: null, quota: 'OK' };
  }
  cleaned = cleaned.slice(first, last + 1);

  let article;
  try {
    article = JSON.parse(cleaned);
  } catch (e) {
    console.error('⚠️ JSON解析失敗:', cleaned.slice(0, 100));
    return { result: null, quota: 'OK' };
  }

  if (!article.title || !article.summary || article.lat == null || article.lng == null) {
    console.error('⚠️ 必須フィールド不足:', Object.keys(article));
    return { result: null, quota: 'OK' };
  }

  // 出典をsourceIndexから取得
  const idx = Math.min(Math.max((article.sourceIndex || 1) - 1, 0), sample.length - 1);
  const chosen = sample[idx];
  article.sources = [{ name: chosen.source, url: chosen.url }];

  return { result: article, quota: 'OK' };
}

// ══════════════════════════════════════════════
//  Firebaseに投稿
// ══════════════════════════════════════════════
async function postToFirebase(token, article) {
  const now = Date.now();
  const displayTitle = `【${article.title}】`;
  let postText = `${displayTitle}\n\n${article.summary}\n\n📰 出典\n`;
  for (const s of article.sources) postText += `・${s.name}\n${s.url}\n`;

  const threadRes = await fetch(`${FIREBASE_DB_URL}/threads.json?auth=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: displayTitle.slice(0, 100),
      createdBy: '🤖 AI NEWS',
      createdByUid: NEWSBOT_UID,
      createdByNick: '🤖 AI NEWS',
      createdAt: now,
      lastActivity: now,
      postCount: 1,
      isNewsThread: true,
      newsCategory: article.category || 'ニュース',
      country: article.country || '',
      lat: article.lat,
      lng: article.lng
    })
  });
  const threadData = await threadRes.json();
  const tid = threadData.name;
  if (!tid) throw new Error('スレッド作成失敗: ' + JSON.stringify(threadData));

  await fetch(`${FIREBASE_DB_URL}/posts/${tid}.json?auth=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uid: NEWSBOT_UID,
      userId: 'ai_news',
      userNick: '🤖 AI NEWS',
      text: postText,
      ts: now,
      isNewsPost: true,
      newsUrl: article.sources[0]?.url || '',
      newsSource: article.sources.map(s => s.name).join(', '),
      newsCategory: article.category || 'ニュース'
    })
  });

  // 重複防止キャッシュ
  const key = Buffer.from(article.sources[0]?.url || article.title)
    .toString('base64').replace(/[.#$/[\]]/g, '_');
  await fetch(`${FIREBASE_DB_URL}/newsArticles/${key}.json?auth=${token}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: article.title,
      url: article.sources[0]?.url || '',
      source: article.sources.map(s => s.name).join(', '),
      category: article.category || 'ニュース',
      country: article.country || '',
      lat: article.lat,
      lng: article.lng,
      postedAt: now,
      tid
    })
  });

  console.log(`✅ 投稿完了: ${displayTitle} (${article.country} ${article.lat},${article.lng})`);
  return tid;
}

// ══════════════════════════════════════════════
//  メイン
// ══════════════════════════════════════════════
async function main() {
  console.log('🤖 Ecstasy ニュースBot 開始');
  console.log(`   モデル: ${CONFIG.MODEL} / 目標件数: ${CONFIG.MAX_ARTICLES}`);

  const token = await getFirebaseToken();
  await clearAllThreads(token);

  // RSS取得
  let allCandidates = [];
  for (const feed of CONFIG.RSS_FEEDS) {
    const articles = await fetchRSS(feed);
    console.log(`   ${feed.source}: ${articles.length}件`);
    allCandidates = allCandidates.concat(articles);
  }
  // URL重複除去
  const uniqueMap = new Map();
  for (const a of allCandidates) if (!uniqueMap.has(a.url)) uniqueMap.set(a.url, a);
  allCandidates = Array.from(uniqueMap.values());
  console.log(`📰 候補合計: ${allCandidates.length}件`);

  // 生成ループ
  const usedUrls   = new Set();
  const usedTitles = new Set();
  let posted    = 0;
  let retries   = 0;

  while (posted < CONFIG.MAX_ARTICLES) {
    console.log(`🤖 記事生成中... (${posted + 1}/${CONFIG.MAX_ARTICLES})`);

    const { result, quota, wait } = await generateOneArticle(allCandidates, usedUrls, usedTitles);

    // クォータ判定
    if (quota === 'DAILY_QUOTA') {
      console.error('🛑 日次クォータ超過のため終了');
      break;
    }
    if (quota === 'RATE_LIMIT') {
      const waitSec = wait ?? CONFIG.DEFAULT_RATE_LIMIT_WAIT;
      console.log(`⏳ レート制限 → ${waitSec}秒待機...`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
      continue; // リトライ（retries を増やさない）
    }

    // 記事が取得できなかった場合
    if (!result) {
      retries++;
      console.log(`⚠️ 記事なし リトライ ${retries}/${CONFIG.MAX_RETRIES}`);
      if (retries >= CONFIG.MAX_RETRIES) {
        console.error('🛑 リトライ上限に達したため終了');
        break;
      }
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }

    // 投稿
    try {
      if (result.sources?.[0]) usedUrls.add(result.sources[0].url);
      usedTitles.add(result.title);
      await postToFirebase(token, result);
      posted++;
      retries = 0; // 成功したらリセット
      await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      console.error(`❌ 投稿失敗: ${e.message}`);
      retries++;
      if (retries >= CONFIG.MAX_RETRIES) {
        console.error('🛑 投稿リトライ上限に達したため終了');
        break;
      }
    }
  }

  console.log(`🏁 完了: ${posted}件投稿`);
}

main().catch(e => {
  console.error('致命的エラー:', e.message);
  process.exit(1);
});
