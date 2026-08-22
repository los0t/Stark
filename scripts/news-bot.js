// scripts/news-bot.js
import fetch from 'node-fetch';
import { parseStringPromise } from 'xml2js';

const CONFIG = {
  // 1回の実行で投稿する記事数
  MAX_ARTICLES: 2,

  // 1記事につき最低2つの出典を目標にする
  MIN_SOURCES: 2,

  // Geminiモデル
  MODEL: 'gemini-2.5-flash',

  // ニュース候補を集めるRSS
  RSS_FEEDS: [
    {
      url: 'https://feeds.bbci.co.uk/news/world/rss.xml',
      source: 'BBC News'
    },
    {
      url: 'https://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml',
      source: 'BBC Entertainment & Arts'
    },
    {
      url: 'https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml',
      source: 'BBC US & Canada'
    },

    // Google News RSS
    {
      url: 'https://news.google.com/rss/search?q=weird+strange+incident+OR+unusual+news&hl=en-US&gl=US&ceid=US:en',
      source: 'Google News'
    },
    {
      url: 'https://news.google.com/rss/search?q=celebrity+OR+youtuber+OR+influencer+news&hl=en-US&gl=US&ceid=US:en',
      source: 'Google News'
    },
    {
      url: 'https://news.google.com/rss/search?q=politics+OR+scandal+OR+controversy&hl=en-US&gl=US&ceid=US:en',
      source: 'Google News'
    },
    {
      url: 'https://news.google.com/rss/search?q=viral+internet+news+OR+social+media+controversy&hl=en-US&gl=US&ceid=US:en',
      source: 'Google News'
    }
  ]
};

const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL;
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const NEWSBOT_EMAIL = process.env.NEWSBOT_EMAIL;
const NEWSBOT_PASSWORD = process.env.NEWSBOT_PASSWORD;
const NEWSBOT_UID = process.env.NEWSBOT_UID;


/* =========================================================
   環境変数チェック
========================================================= */

if (
  !FIREBASE_DB_URL ||
  !FIREBASE_API_KEY ||
  !GEMINI_API_KEY ||
  !NEWSBOT_EMAIL ||
  !NEWSBOT_PASSWORD ||
  !NEWSBOT_UID
) {
  throw new Error('必要な環境変数が設定されていません');
}


/* =========================================================
   Firebase Authentication
========================================================= */

async function getFirebaseToken() {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email: NEWSBOT_EMAIL,
        password: NEWSBOT_PASSWORD,
        returnSecureToken: true
      })
    }
  );

  const data = await res.json();

  if (!data.idToken) {
    throw new Error(
      'Firebase Auth失敗: ' + JSON.stringify(data)
    );
  }

  console.log('✅ Firebase Auth成功');

  return data.idToken;
}


/* =========================================================
   RSS取得
========================================================= */

async function fetchRSS(feed) {
  try {
    console.log(`📡 RSS取得: ${feed.source}`);

    const res = await fetch(feed.url, {
      headers: {
        'User-Agent': 'EcstasyNewsBot/1.0'
      }
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const xml = await res.text();

    const parsed = await parseStringPromise(xml, {
      explicitArray: false
    });

    const channel = parsed.rss?.channel;

    if (!channel) {
      throw new Error('RSSのパースに失敗');
    }

    const rawItems = channel.item;

    const items = Array.isArray(rawItems)
      ? rawItems
      : rawItems
        ? [rawItems]
        : [];

    return items.map(item => {
      let url = '';

      if (typeof item.link === 'string') {
        url = item.link;
      } else if (item.link?._) {
        url = item.link._;
      }

      let description = '';

      if (typeof item.description === 'string') {
        description = item.description;
      } else if (item.description?._) {
        description = item.description._;
      }

      let pubDate = '';

      if (typeof item.pubDate === 'string') {
        pubDate = item.pubDate;
      }

      return {
        title: item.title || '',
        url,
        description,
        pubDate,
        source: feed.source
      };
    }).filter(item => item.title && item.url);

  } catch (error) {
    console.error(
      `❌ ${feed.source} 取得失敗: ${error.message}`
    );

    return [];
  }
}


/* =========================================================
   Firebaseから過去記事取得
========================================================= */

async function getExistingArticles(token) {
  const res = await fetch(
    `${FIREBASE_DB_URL}/newsArticles.json?auth=${token}`
  );

  if (!res.ok) {
    throw new Error(
      `既存記事取得失敗: HTTP ${res.status}`
    );
  }

  const data = await res.json();

  if (!data) {
    return [];
  }

  return Object.values(data);
}


/* =========================================================
   Geminiで記事生成
========================================================= */

async function generateArticles(candidates, existingArticles) {

  /*
   * 過去記事のタイトルをGeminiに渡して
   * 同じニュースを再投稿しにくくする
   */

  const previousTitles = existingArticles
    .map(article => article.title)
    .filter(Boolean)
    .slice(-100);

  /*
   * Geminiに渡す候補を整理
   */
  const candidateText = candidates
    .slice(0, 100)
    .map((article, index) => {
      return `
---候補 ${index + 1}---

媒体: ${article.source}
タイトル: ${article.title}
公開日時: ${article.pubDate}
URL: ${article.url}

概要:
${article.description}
`;
    })
    .join('\n');


  const prompt = `
あなたは「Ecstasy」という日本語SNSのニュース編集AIです。

以下に複数のニュースRSSから取得したニュース候補があります。

これらを比較・照合し、
日本の若者が興味を持ちそうなニュースを2件選び、
Ecstasy用の記事として作成してください。

==================================================
【最重要：情報の信頼性】
==================================================

- 候補記事に存在する情報だけを使用してください。
- 架空の情報を作らないでください。
- 事実と推測を混ぜないでください。
- 元記事の文章をそのままコピーしないでください。
- 自分の言葉で要約してください。
- 重大な内容は特に慎重に扱ってください。
- 「逮捕」「死亡」「犯罪」「性的スキャンダル」などは、
  候補情報から明確に確認できる場合だけ使用してください。
- 噂やSNS上の未確認情報を事実として断定しないでください。
- 同じ出来事を複数の記事が報じている場合、
  複数の情報源を比較して共通して確認できる内容を優先してください。

==================================================
【記事ジャンル】
==================================================

以下を優先してください。

・海外で起きた珍事件
・海外のおもしろニュース
・日本人があまり知らない海外事情
・意外な法律や制度
・政治・社会のおもしろい話
・芸能人のニュース
・YouTuber
・インフルエンサー
・SNSで話題になっている出来事
・スキャンダル
・海外の変わった文化
・「実は○○だった」系の意外な情報

特に、
「何それ！？」
「どういうこと？」
「詳しく知りたい」
と思わせるようなニュースを優先してください。

==================================================
【見出し】
==================================================

見出しはSNSで目を引くものにしてください。

例えば、

【まさかの展開】○○をめぐり海外で思わぬ騒動に

【実は○○だった！？】知られざる○○の事実

【なぜこうなった？】○○をめぐって大きな話題に

などのような形式です。

ただし、

・嘘をつかない
・事実を歪めない
・本文にない情報を追加しない
・過度に煽らない

こと。

「！？」などの記号は使用して構いません。

==================================================
【本文】
==================================================

1記事400〜700文字程度。

以下を自然な文章で説明してください。

・何が起きたのか
・いつ起きたのか
・どこで起きたのか
・誰が関係しているのか
・なぜ話題になったのか
・現在どうなっているのか
・必要なら背景

単なる箇条書きではなく、
読みやすいニュース記事にしてください。

==================================================
【出典】
==================================================

非常に重要です。

1記事につき最低2つの異なる情報源を付けてください。

同じ出来事について複数の候補記事が存在する場合、
それらを比較して記事を作成してください。

出典URLは、必ず候補として与えられたURLの中から選んでください。

架空のURLを作らないでください。

できれば、

・BBC
・Reuters
・AP
・Guardian
・CNN
・その他信頼できる報道機関

など、異なる媒体を組み合わせてください。

ただし、候補に存在しない媒体を無理に追加しないでください。

==================================================
【過去の記事】
==================================================

以下のタイトルと同じニュースは避けてください。

${previousTitles.join('\n')}

==================================================
【ニュース候補】
==================================================

${candidateText}

==================================================
【出力形式】
==================================================

必ずJSONのみを出力してください。

{
  "articles": [
    {
      "title": "記事の見出し",
      "summary": "400〜700文字程度の記事本文",
      "category": "海外事件",
      "sources": [
        {
          "name": "媒体名",
          "url": "候補として与えられたURL"
        },
        {
          "name": "媒体名",
          "url": "候補として与えられたURL"
        }
      ]
    },
    {
      "title": "記事の見出し",
      "summary": "400〜700文字程度の記事本文",
      "category": "芸能",
      "sources": [
        {
          "name": "媒体名",
          "url": "候補として与えられたURL"
        },
        {
          "name": "媒体名",
          "url": "候補として与えられたURL"
        }
      ]
    }
  ]
}

categoryは以下のいずれかを使用してください。

海外事件
海外ニュース
政治・社会
芸能
YouTuber・インフルエンサー
スキャンダル
雑学
その他
`;


  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: prompt
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 7000
        }
      })
    }
  );

  const data = await res.json();

  if (!res.ok) {
    throw new Error(
      'Gemini API失敗: ' +
      JSON.stringify(data)
    );
  }

  const text =
    data.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    throw new Error(
      'Geminiから記事が返されませんでした: ' +
      JSON.stringify(data)
    );
  }

  /*
   * ```json が付いた場合に除去
   */
  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let result;

  try {
    result = JSON.parse(cleaned);
  } catch (error) {
    console.error('Geminiの返答:', text);

    throw new Error(
      'GeminiのJSON解析に失敗しました'
    );
  }

  if (!Array.isArray(result.articles)) {
    throw new Error(
      'Geminiのarticlesが配列ではありません'
    );
  }

  return result.articles
    .filter(article => {
      return (
        article &&
        article.title &&
        article.summary &&
        Array.isArray(article.sources)
      );
    })
    .slice(0, CONFIG.MAX_ARTICLES);
}


/* =========================================================
   URLが候補記事に存在するか確認
========================================================= */

function validateSources(article, candidates) {

  const candidateUrls = new Set(
    candidates.map(item => item.url)
  );

  const validSources = [];

  for (const source of article.sources) {

    if (
      !source ||
      !source.name ||
      !source.url
    ) {
      continue;
    }

    /*
     * Geminiが候補に存在しない架空URLを作っていないか確認
     */
    if (!candidateUrls.has(source.url)) {
      console.log(
        `⚠️ 候補に存在しないURLを除外: ${source.url}`
      );

      continue;
    }

    /*
     * 同じURLを重複させない
     */
    if (
      !validSources.some(
        item => item.url === source.url
      )
    ) {
      validSources.push({
        name: source.name,
        url: source.url
      });
    }
  }

  return validSources;
}


/* =========================================================
   Firebase投稿
========================================================= */

async function postToFirebase(token, article) {

  const now = Date.now();

  const displayTitle =
    `【${article.category || 'ニュース'}】${article.title}`;


  /*
   * 本文
   */
  let postText =
    `${article.summary}\n\n` +
    `📰 出典\n`;

  for (const source of article.sources) {
    postText +=
      `・${source.name}\n` +
      `${source.url}\n`;
  }


  /* スレッド作成 */

  const threadRes = await fetch(
    `${FIREBASE_DB_URL}/threads.json?auth=${token}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        title: displayTitle.slice(0, 100),
        createdBy: '🤖 AI NEWS',
        createdByUid: NEWSBOT_UID,
        createdByNick: '🤖 AI NEWS',
        createdAt: now,
        lastActivity: now,
        postCount: 1,
        isNewsThread: true,
        newsCategory:
          article.category || 'ニュース'
      })
    }
  );

  const threadData = await threadRes.json();

  const tid = threadData.name;

  if (!tid) {
    throw new Error(
      'スレッド作成失敗: ' +
      JSON.stringify(threadData)
    );
  }


  /* 本文投稿 */

  const postRes = await fetch(
    `${FIREBASE_DB_URL}/posts/${tid}.json?auth=${token}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        uid: NEWSBOT_UID,
        userId: 'ai_news',
        userNick: '🤖 AI NEWS',
        text: postText,
        ts: now,
        isNewsPost: true,

        /*
         * 旧コードとの互換用
         */
        newsUrl:
          article.sources[0]?.url || '',

        newsSource:
          article.sources
            .map(source => source.name)
            .join(', '),

        /*
         * 複数出典
         */
        newsSources: article.sources,

        newsCategory:
          article.category || 'ニュース'
      })
    }
  );

  if (!postRes.ok) {
    throw new Error(
      `ニュース本文投稿失敗: HTTP ${postRes.status}`
    );
  }


  /* 投稿済みニュースとして保存 */

  /*
   * 複数URLをまとめてキーにする
   */
  const sourceKey = article.sources
    .map(source => source.url)
    .sort()
    .join('|');

  const key = Buffer
    .from(sourceKey)
    .toString('base64')
    .replace(/[.#$/[\]]/g, '_');


  await fetch(
    `${FIREBASE_DB_URL}/newsArticles/${key}.json?auth=${token}`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        title: article.title,
        url: article.sources[0]?.url || '',
        source:
          article.sources
            .map(source => source.name)
            .join(', '),

        sources: article.sources,

        category:
          article.category || 'ニュース',

        postedAt: now,
        tid
      })
    }
  );


  console.log(
    `✅ 投稿完了: ${displayTitle}`
  );

  console.log(
    `   出典数: ${article.sources.length}`
  );

  return tid;
}


/* =========================================================
   メイン
========================================================= */

async function main() {

  console.log(
    '🤖 Ecstasy ニュースBot 開始'
  );

  const token =
    await getFirebaseToken();


  /* ---------------------------------------------
     既存記事取得
  --------------------------------------------- */

  const existingArticles =
    await getExistingArticles(token);

  console.log(
    `📚 既存記事: ${existingArticles.length}件`
  );


  /* ---------------------------------------------
     複数RSSからニュース候補を収集
  --------------------------------------------- */

  let allCandidates = [];

  for (const feed of CONFIG.RSS_FEEDS) {

    const articles =
      await fetchRSS(feed);

    console.log(
      `   ${articles.length}件取得`
    );

    allCandidates =
      allCandidates.concat(articles);
  }


  console.log(
    `📰 合計 ${allCandidates.length}件の候補を取得`
  );


  /*
   * URL重複を削除
   */

  const uniqueMap = new Map();

  for (const article of allCandidates) {

    if (!uniqueMap.has(article.url)) {
      uniqueMap.set(article.url, article);
    }
  }

  allCandidates =
    Array.from(uniqueMap.values());


  /*
   * 古い候補をある程度除外
   * 最大100件をGeminiに渡す
   */

  allCandidates =
    allCandidates.slice(0, 100);


  if (allCandidates.length === 0) {

    console.log(
      '⚠️ ニュース候補がありません'
    );

    return;
  }


  /* ---------------------------------------------
     Geminiで2記事作成
  --------------------------------------------- */

  console.log(
    '🤖 Geminiでニュースを分析・記事化中...'
  );

  let articles;

  try {

    articles =
      await generateArticles(
        allCandidates,
        existingArticles
      );

  } catch (error) {

    console.error(
      `❌ 記事生成失敗: ${error.message}`
    );

    throw error;
  }


  console.log(
    `🤖 Geminiが ${articles.length}件の記事を生成`
  );


  /* ---------------------------------------------
     投稿
  --------------------------------------------- */

  let posted = 0;

  for (const article of articles) {

    try {

      /*
       * Geminiが返した出典を候補URLと照合
       */

      const validSources =
        validateSources(
          article,
          allCandidates
        );


      /*
       * 最低2つの出典がなければ投稿しない
       *
       * これにより、
       * 「1つの記事だけを根拠にしたニュース」
       * を防ぐ
       */

      if (
        validSources.length <
        CONFIG.MIN_SOURCES
      ) {

        console.log(
          `⚠️ 出典不足のため投稿スキップ: ${article.title}`
        );

        console.log(
          `   出典数: ${validSources.length}`
        );

        continue;
      }


      article.sources =
        validSources;


      /*
       * 既存URLと重複していないか確認
       */

      const existingUrls =
        new Set(
          existingArticles
            .map(item => item.url)
            .filter(Boolean)
        );


      const alreadyPosted =
        article.sources.some(
          source =>
            existingUrls.has(source.url)
        );


      if (alreadyPosted) {

        console.log(
          `⏭️ 既存ニュースと重複: ${article.title}`
        );

        continue;
      }


      await postToFirebase(
        token,
        article
      );

      posted++;


      /*
       * 連続投稿を少し待つ
       */

      await new Promise(resolve =>
        setTimeout(resolve, 3000)
      );


    } catch (error) {

      console.error(
        `❌ 投稿失敗: ${error.message}`
      );
    }
  }


  console.log(
    `🏁 完了: ${posted}件投稿`
  );
}


main().catch(error => {

  console.error(
    '致命的エラー:',
    error
  );

  process.exit(1);
});