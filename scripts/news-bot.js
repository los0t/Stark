import fetch from 'node-fetch';
import { parseStringPromise } from 'xml2js';

const CONFIG = {
  // 1回の実行で投稿する記事数
  MAX_ARTICLES: 2,

  // 1記事につき最低2つの出典
  MIN_SOURCES: 2,

  // メインモデル
  MODEL: 'gemini-3.6-flash',

  // フォールバックモデル
  FALLBACK_MODEL: 'gemini-3.5-flash-lite',

  // Gemini API最大リトライ回数
  MAX_RETRIES: 4,

  // Geminiへ送るRSS候補数
  // ★30件に変更
  MAX_CANDIDATES: 30,

  // GeminiのJSON再生成回数
  MAX_JSON_RETRIES: 1,

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

  if (!res.ok || !data.idToken) {

    throw new Error(
      'Firebase Auth失敗: ' +
      JSON.stringify(data)
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

    console.log(
      `📡 RSS取得: ${feed.source}`
    );

    const res = await fetch(
      feed.url,
      {
        headers: {
          'User-Agent':
            'EcstasyNewsBot/1.0'
        }
      }
    );

    if (!res.ok) {

      throw new Error(
        `HTTP ${res.status}`
      );
    }

    const xml =
      await res.text();

    const parsed =
      await parseStringPromise(
        xml,
        {
          explicitArray: false
        }
      );

    const channel =
      parsed.rss?.channel;

    if (!channel) {

      throw new Error(
        'RSSのパースに失敗'
      );
    }

    const rawItems =
      channel.item;

    const items =
      Array.isArray(rawItems)
        ? rawItems
        : rawItems
          ? [rawItems]
          : [];

    return items
      .map(item => {

        let url = '';

        if (
          typeof item.link ===
          'string'
        ) {

          url =
            item.link;

        } else if (
          item.link?._
        ) {

          url =
            item.link._;
        }


        let description = '';

        if (
          typeof item.description ===
          'string'
        ) {

          description =
            item.description;

        } else if (
          item.description?._
        ) {

          description =
            item.description._;
        }


        let pubDate = '';

        if (
          typeof item.pubDate ===
          'string'
        ) {

          pubDate =
            item.pubDate;
        }


        return {
          title:
            item.title || '',

          url,

          description,

          pubDate,

          source:
            feed.source
        };

      })

      .filter(
        item =>
          item.title &&
          item.url
      );

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

  const data =
    await res.json();

  if (!data) {
    return [];
  }

  return Object.values(data);
}


/* =========================================================
   スリープ
========================================================= */

function sleep(ms) {

  return new Promise(
    resolve =>
      setTimeout(resolve, ms)
  );
}


/* =========================================================
   Geminiエラー情報
========================================================= */

class GeminiAPIError extends Error {

  constructor(
    message,
    status,
    data
  ) {

    super(message);

    this.name =
      'GeminiAPIError';

    this.status =
      status;

    this.data =
      data;
  }
}


/* =========================================================
   Gemini APIリトライ判定
========================================================= */

function shouldRetryGemini(status) {

  return [
    500,
    502,
    503,
    504
  ].includes(status);
}


/* =========================================================
   429判定
========================================================= */

function isGeminiQuotaError(error) {

  return (
    error &&
    (
      error.status === 429 ||
      error?.data?.error?.status ===
        'RESOURCE_EXHAUSTED'
    )
  );
}


/* =========================================================
   Gemini API呼び出し
========================================================= */

async function callGemini(
  model,
  prompt
) {

  let lastError =
    null;

  for (
    let attempt = 1;
    attempt <= CONFIG.MAX_RETRIES;
    attempt++
  ) {

    try {

      console.log(
        `🤖 Gemini API実行: ${model} (${attempt}/${CONFIG.MAX_RETRIES})`
      );

      const res =
        await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: 'POST',

            headers: {
              'Content-Type':
                'application/json'
            },

            body:
              JSON.stringify({

                contents: [
                  {
                    parts: [
                      {
                        text:
                          prompt
                      }
                    ]
                  }
                ],

                /*
                 * Google検索を利用
                 */
                tools: [
                  {
                    google_search: {}
                  }
                ],

                generationConfig: {

                  maxOutputTokens:
                    7000,

                  responseMimeType:
                    'application/json'
                }

              })
          }
        );

      const data =
        await res.json();


      /* ===================================================
         成功
      =================================================== */

      if (res.ok) {

        return data;
      }


      /* ===================================================
         429
         
         ★重要
         429はクォータ超過の可能性が高いため、
         同じモデルを何度も叩かない。
      =================================================== */

      if (res.status === 429) {

        throw new GeminiAPIError(
          `Gemini API HTTP 429: ${JSON.stringify(data)}`,
          429,
          data
        );
      }


      /* ===================================================
         500系
      =================================================== */

      if (
        shouldRetryGemini(
          res.status
        )
      ) {

        lastError =
          new GeminiAPIError(
            `Gemini API HTTP ${res.status}: ${JSON.stringify(data)}`,
            res.status,
            data
          );

        const waitTime =
          Math.min(
            30000,
            2000 *
              Math.pow(
                2,
                attempt - 1
              )
          );

        console.warn(
          `⚠️ Gemini ${res.status}。${waitTime / 1000}秒後に再試行します`
        );

        await sleep(
          waitTime
        );

        continue;
      }


      /* ===================================================
         その他
      =================================================== */

      throw new GeminiAPIError(
        'Gemini API失敗: ' +
          JSON.stringify(data),
        res.status,
        data
      );

    } catch (error) {

      /*
       * 429は即座に上へ返す
       *
       * 無料枠超過なのに4回も叩くのを防止
       */

      if (
        isGeminiQuotaError(
          error
        )
      ) {

        throw error;
      }


      lastError =
        error;


      /*
       * 通信エラー
       */

      if (
        attempt <
        CONFIG.MAX_RETRIES
      ) {

        const waitTime =
          Math.min(
            30000,
            2000 *
              Math.pow(
                2,
                attempt - 1
              )
          );

        console.warn(
          `⚠️ Gemini通信エラー。${waitTime / 1000}秒後に再試行します`
        );

        await sleep(
          waitTime
        );

        continue;
      }

      break;
    }
  }

  throw (
    lastError ||
    new Error(
      'Gemini APIに接続できませんでした'
    )
  );
}


/* =========================================================
   Geminiレスポンスから検索結果を取得
========================================================= */

function extractGroundingSources(
  data
) {

  const sources =
    [];

  const candidates =
    data.candidates || [];

  for (
    const candidate
    of candidates
  ) {

    const metadata =
      candidate.groundingMetadata;

    if (!metadata) {
      continue;
    }

    const chunks =
      metadata.groundingChunks ||
      [];

    for (
      const chunk
      of chunks
    ) {

      const web =
        chunk.web;

      if (
        web &&
        web.uri &&
        web.title
      ) {

        if (
          !sources.some(
            source =>
              source.url ===
              web.uri
          )
        ) {

          sources.push({

            name:
              web.title,

            url:
              web.uri
          });
        }
      }
    }
  }

  return sources;
}


/* =========================================================
   JSONクリーニング
========================================================= */

function cleanGeminiJson(
  text
) {

  return text
    .replace(
      /^```json\s*/i,
      ''
    )
    .replace(
      /^```\s*/i,
      ''
    )
    .replace(
      /\s*```$/i,
      ''
    )
    .trim();
}


/* =========================================================
   Geminiで記事生成
========================================================= */

async function generateArticles(
  candidates,
  existingArticles
) {

  const previousTitles =
    existingArticles
      .map(
        article =>
          article.title
      )
      .filter(Boolean)
      .slice(-100);


  const candidateText =
    candidates
      .slice(
        0,
        CONFIG.MAX_CANDIDATES
      )
      .map(
        (article, index) => {

          return `
---RSS候補 ${index + 1}---

媒体:
${article.source}

タイトル:
${article.title}

公開日時:
${article.pubDate}

URL:
${article.url}

概要:
${article.description}
`;

        }
      )
      .join('\n');


  const prompt = `

あなたは「Ecstasy」という日本語SNSのニュース編集AIです。

あなたの仕事は、最新のニュースをGoogle検索とRSS候補から調査し、
日本の若者が興味を持ちそうなニュースを2件選び、
Ecstasy用の記事として作成することです。


==================================================
【最重要：リアルタイム検索】
==================================================

Google検索を必ず活用してください。

RSS候補だけに限定する必要はありません。

RSSに存在しないニュースでも、
Google検索で実際に確認できるニュースであれば
記事候補として使用して構いません。

ただし、必ず実際のWeb上の情報を確認してください。

検索結果に存在しない情報を作らないでください。


==================================================
【出典】
==================================================

非常に重要です。

1記事につき最低2つの異なるWeb上の情報源を使用してください。

可能な限り異なる報道機関を組み合わせてください。

優先例：

・BBC
・Reuters
・AP
・The Guardian
・CNN
・NBC
・ABC
・CBS
・Fox News
・Sky News
・その他の信頼できる報道機関

ただし、実際に検索結果として存在する記事だけを使用してください。

架空のURLは禁止です。

Google検索で確認できたURLだけを
sourcesに入れてください。


==================================================
【情報の信頼性】
==================================================

・架空の情報を作らない
・検索結果に存在しない事実を追加しない
・事実と推測を混ぜない
・元記事をそのままコピーしない
・自分の言葉で要約する
・重大な内容は特に慎重に扱う
・「逮捕」「死亡」「犯罪」「性的スキャンダル」などは、
  信頼できる情報源で明確に確認できる場合だけ使用する
・SNS上の未確認情報を事実として断定しない
・可能な限り複数の報道機関で同じ出来事を確認する


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

と思わせるニュースを優先してください。


==================================================
【見出し】
==================================================

SNSで目を引く見出しにしてください。

例：

【まさかの展開】○○をめぐり海外で思わぬ騒動に

【実は○○だった！？】知られざる○○の事実

【なぜこうなった？】○○をめぐって大きな話題に

ただし、

・嘘をつかない
・事実を歪めない
・本文にない情報を追加しない
・過度に煽らない

こと。


==================================================
【本文】
==================================================

1記事400〜700文字程度。

自然なニュース記事として書いてください。

以下を可能な範囲で含めてください。

・何が起きたのか
・いつ起きたのか
・どこで起きたのか
・誰が関係しているのか
・なぜ話題になったのか
・現在どうなっているのか
・必要なら背景


==================================================
【過去の記事】
==================================================

以下のタイトルと同じニュースは避けてください。

${previousTitles.join('\n')}


==================================================
【RSSニュース候補】
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
          "url": "実際に検索結果として存在するURL"
        },
        {
          "name": "媒体名",
          "url": "実際に検索結果として存在するURL"
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
          "url": "実際に検索結果として存在するURL"
        },
        {
          "name": "媒体名",
          "url": "実際に検索結果として存在するURL"
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


  let data;

  /*
   * ================================================
   * メインモデル
   * ================================================
   */

  try {

    data =
      await callGemini(
        CONFIG.MODEL,
        prompt
      );

  } catch (error) {

    /*
     * 429の場合
     *
     * メインモデルを無駄に再試行しない。
     */

    if (
      isGeminiQuotaError(
        error
      )
    ) {

      console.warn(
        `⚠️ ${CONFIG.MODEL} がクォータ制限(429)に到達しました`
      );

      console.log(
        `🔄 フォールバックモデル ${CONFIG.FALLBACK_MODEL} を試します`
      );

    } else {

      console.warn(
        `⚠️ ${CONFIG.MODEL} が利用できません`
      );

      console.warn(
        error.message
      );

      console.log(
        `🔄 フォールバックモデル ${CONFIG.FALLBACK_MODEL} を試します`
      );
    }


    /*
     * ================================================
     * フォールバック
     * ================================================
     */

    try {

      data =
        await callGemini(
          CONFIG.FALLBACK_MODEL,
          prompt
        );

    } catch (fallbackError) {

      /*
       * 両方429なら呼び出し元へ
       */

      if (
        isGeminiQuotaError(
          fallbackError
        )
      ) {

        throw fallbackError;
      }

      throw fallbackError;
    }
  }


  const text =
    data.candidates
      ?.[
        0
      ]
      ?.content
      ?.parts
      ?.[
        0
      ]
      ?.text;


  if (!text) {

    throw new Error(
      'Geminiから記事が返されませんでした: ' +
      JSON.stringify(data)
    );
  }


  /*
   * Google検索による出典
   */

  const groundingSources =
    extractGroundingSources(
      data
    );


  console.log(
    `🔎 Google検索から ${groundingSources.length}件の出典候補を取得`
  );


  /*
   * JSON解析
   */

  let result;

  const cleaned =
    cleanGeminiJson(
      text
    );


  try {

    result =
      JSON.parse(
        cleaned
      );

  } catch (error) {

    console.error(
      '⚠️ GeminiのJSON解析に失敗しました'
    );

    console.log(
      '🔄 JSONを再生成します'
    );


    const retryPrompt =
      `${prompt}

重要：
前回の出力はJSONとして解析できませんでした。

今回は必ず有効なJSONだけを返してください。

Markdownは禁止です。
コードブロックは禁止です。
説明文は禁止です。

JSONオブジェクトだけを返してください。
`;


    let retryData;


    try {

      retryData =
        await callGemini(
          CONFIG.MODEL,
          retryPrompt
        );

    } catch (retryError) {

      /*
       * JSON再生成でも429なら
       * ここではさらに無限にAPIを叩かない。
       */

      if (
        isGeminiQuotaError(
          retryError
        )
      ) {

        throw retryError;
      }


      retryData =
        await callGemini(
          CONFIG.FALLBACK_MODEL,
          retryPrompt
        );
    }


    const retryText =
      retryData.candidates
        ?.[
          0
        ]
        ?.content
        ?.parts
        ?.[
          0
        ]
        ?.text;


    if (!retryText) {

      throw new Error(
        'Gemini再生成でも記事が返されませんでした'
      );
    }


    const retryCleaned =
      cleanGeminiJson(
        retryText
      );


    try {

      result =
        JSON.parse(
          retryCleaned
        );

    } catch {

      console.error(
        'Gemini再生成結果:',
        retryText
      );

      throw new Error(
        'GeminiのJSON解析に失敗しました'
      );
    }
  }


  if (
    !Array.isArray(
      result.articles
    )
  ) {

    throw new Error(
      'Geminiのarticlesが配列ではありません'
    );
  }


  /*
   * Google検索出典を補完
   */

  for (
    const article
    of result.articles
  ) {

    if (
      !Array.isArray(
        article.sources
      )
    ) {

      article.sources =
        [];
    }


    for (
      const source
      of groundingSources
    ) {

      if (
        article.sources.length >=
        CONFIG.MIN_SOURCES
      ) {

        break;
      }


      if (
        !source ||
        !source.url
      ) {

        continue;
      }


      if (
        !article.sources.some(
          item =>
            item &&
            item.url ===
            source.url
        )
      ) {

        article.sources.push({

          name:
            source.name,

          url:
            source.url
        });
      }
    }
  }


  return result.articles
    .filter(
      article =>
        article &&
        article.title &&
        article.summary &&
        Array.isArray(
          article.sources
        )
    )
    .slice(
      0,
      CONFIG.MAX_ARTICLES
    );
}


/* =========================================================
   出典URLの検証
========================================================= */

function validateSources(
  article,
  candidates
) {

  const candidateUrls =
    new Set(
      candidates.map(
        item =>
          item.url
      )
    );


  const validSources =
    [];


  for (
    const source
    of article.sources
  ) {

    if (
      !source ||
      !source.name ||
      !source.url
    ) {

      continue;
    }


    let parsedUrl;

    try {

      parsedUrl =
        new URL(
          source.url
        );

    } catch {

      console.log(
        `⚠️ 不正なURLを除外: ${source.url}`
      );

      continue;
    }


    if (
      parsedUrl.protocol !==
        'http:' &&
      parsedUrl.protocol !==
        'https:'
    ) {

      continue;
    }


    if (
      candidateUrls.has(
        source.url
      )
    ) {

      console.log(
        `📰 RSS出典: ${source.name}`
      );

    } else {

      console.log(
        `🌐 Web検索出典: ${source.name}`
      );
    }


    if (
      !validSources.some(
        item =>
          item.url ===
          source.url
      )
    ) {

      validSources.push({

        name:
          source.name,

        url:
          source.url
      });
    }
  }


  return validSources;
}


/* =========================================================
   通常ニュース投稿
========================================================= */

async function postToFirebase(
  token,
  article
) {

  const now =
    Date.now();


  const displayTitle =
    `【${article.category || 'ニュース'}】${article.title}`;


  let postText =
    `${article.summary}\n\n` +
    `📰 出典\n`;


  for (
    const source
    of article.sources
  ) {

    postText +=
      `・${source.name}\n` +
      `${source.url}\n`;
  }


  /* =======================================================
     スレッド作成
  ======================================================= */

  const threadRes =
    await fetch(
      `${FIREBASE_DB_URL}/threads.json?auth=${token}`,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json'
        },

        body:
          JSON.stringify({

            title:
              displayTitle.slice(
                0,
                100
              ),

            createdBy:
              '🤖 AI NEWS',

            createdByUid:
              NEWSBOT_UID,

            createdByNick:
              '🤖 AI NEWS',

            createdAt:
              now,

            lastActivity:
              now,

            postCount:
              1,

            isNewsThread:
              true,

            newsCategory:
              article.category ||
              'ニュース'
          })
      }
    );


  if (!threadRes.ok) {

    throw new Error(
      `スレッド作成失敗: HTTP ${threadRes.status}`
    );
  }


  const threadData =
    await threadRes.json();


  const tid =
    threadData.name;


  if (!tid) {

    throw new Error(
      'スレッド作成失敗: ' +
      JSON.stringify(
        threadData
      )
    );
  }


  /* =======================================================
     本文投稿
  ======================================================= */

  const postRes =
    await fetch(
      `${FIREBASE_DB_URL}/posts/${tid}.json?auth=${token}`,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json'
        },

        body:
          JSON.stringify({

            uid:
              NEWSBOT_UID,

            userId:
              'ai_news',

            userNick:
              '🤖 AI NEWS',

            text:
              postText,

            ts:
              now,

            isNewsPost:
              true,

            newsUrl:
              article.sources[0]
                ?.url ||
              '',

            newsSource:
              article.sources
                .map(
                  source =>
                    source.name
                )
                .join(', '),

            newsSources:
              article.sources,

            newsCategory:
              article.category ||
              'ニュース'
          })
      }
    );


  if (!postRes.ok) {

    throw new Error(
      `ニュース本文投稿失敗: HTTP ${postRes.status}`
    );
  }


  /* =======================================================
     投稿済みニュース保存
  ======================================================= */

  const sourceKey =
    article.sources
      .map(
        source =>
          source.url
      )
      .sort()
      .join('|');


  const key =
    Buffer
      .from(sourceKey)
      .toString('base64')
      .replace(
        /[.#$/[\]]/g,
        '_'
      );


  const saveRes =
    await fetch(
      `${FIREBASE_DB_URL}/newsArticles/${key}.json?auth=${token}`,
      {
        method: 'PUT',

        headers: {
          'Content-Type':
            'application/json'
        },

        body:
          JSON.stringify({

            title:
              article.title,

            url:
              article.sources[0]
                ?.url ||
              '',

            source:
              article.sources
                .map(
                  source =>
                    source.name
                )
                .join(', '),

            sources:
              article.sources,

            category:
              article.category ||
              'ニュース',

            postedAt:
              now,

            tid
          })
      }
    );


  if (!saveRes.ok) {

    throw new Error(
      `ニュース履歴保存失敗: HTTP ${saveRes.status}`
    );
  }


  console.log(
    `✅ 投稿完了: ${displayTitle}`
  );

  console.log(
    `   出典数: ${article.sources.length}`
  );


  return tid;
}


/* =========================================================
   429時の一言つぶやき
========================================================= */

const FALLBACK_MESSAGES = [

  '🤖 今日はちょっと一休み。ニュースを調査中です。',

  '🌎 世界では今日もいろんなことが起きているみたいです。',

  '☕ ニュースを集めながら、ひと息ついています。',

  '👀 面白いニュースを探しています。もう少しお待ちください。',

  '🤖 EcstasyニュースBot、ただいま情報収集中です。',

  '🌐 今日も世界中からニュースを探しています。',

  '📰 次のニュースを準備中です。',

  '🔎 面白い話題がないか世界中を探索中……',

  '🤖 ニュースが届くまで少々お待ちください。',

  '🌍 世界は今日も何か起こしているようです。'
];


/* =========================================================
   429時のつぶやき投稿
========================================================= */

async function postFallbackTweet(
  token
) {

  const now =
    Date.now();


  const message =
    FALLBACK_MESSAGES[
      Math.floor(
        Math.random() *
          FALLBACK_MESSAGES.length
      )
    ];


  console.log(
    `💬 Geminiクォータ超過のため一言投稿: ${message}`
  );


  /* =======================================================
     スレッド作成
  ======================================================= */

  const threadRes =
    await fetch(
      `${FIREBASE_DB_URL}/threads.json?auth=${token}`,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json'
        },

        body:
          JSON.stringify({

            title:
              '🤖 AI NEWS',

            createdBy:
              '🤖 AI NEWS',

            createdByUid:
              NEWSBOT_UID,

            createdByNick:
              '🤖 AI NEWS',

            createdAt:
              now,

            lastActivity:
              now,

            postCount:
              1,

            isNewsThread:
              false
          })
      }
    );


  if (!threadRes.ok) {

    throw new Error(
      `つぶやきスレッド作成失敗: HTTP ${threadRes.status}`
    );
  }


  const threadData =
    await threadRes.json();


  const tid =
    threadData.name;


  if (!tid) {

    throw new Error(
      'つぶやきスレッド作成失敗: ' +
      JSON.stringify(
        threadData
      )
    );
  }


  /* =======================================================
     つぶやき投稿
  ======================================================= */

  const postRes =
    await fetch(
      `${FIREBASE_DB_URL}/posts/${tid}.json?auth=${token}`,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json'
        },

        body:
          JSON.stringify({

            uid:
              NEWSBOT_UID,

            userId:
              'ai_news',

            userNick:
              '🤖 AI NEWS',

            text:
              message,

            ts:
              now,

            isNewsPost:
              false
          })
      }
    );


  if (!postRes.ok) {

    throw new Error(
      `つぶやき投稿失敗: HTTP ${postRes.status}`
    );
  }


  console.log(
    `✅ 429時のつぶやき投稿完了`
  );

  return tid;
}


/* =========================================================
   メイン処理
========================================================= */

async function main() {

  console.log(
    '🤖 Ecstasy ニュースBot 開始'
  );


  /* =======================================================
     Firebaseログイン
  ======================================================= */

  const token =
    await getFirebaseToken();


  /* =======================================================
     過去記事取得
  ======================================================= */

  const existingArticles =
    await getExistingArticles(
      token
    );


  console.log(
    `📚 既存記事: ${existingArticles.length}件`
  );


  /* =======================================================
     RSS取得
  ======================================================= */

  let allCandidates =
    [];


  for (
    const feed
    of CONFIG.RSS_FEEDS
  ) {

    const articles =
      await fetchRSS(
        feed
      );


    console.log(
      `   ${articles.length}件取得`
    );


    allCandidates =
      allCandidates.concat(
        articles
      );
  }


  console.log(
    `📰 合計 ${allCandidates.length}件の候補を取得`
  );


  /* =======================================================
     URL重複削除
  ======================================================= */

  const uniqueMap =
    new Map();


  for (
    const article
    of allCandidates
  ) {

    if (
      !uniqueMap.has(
        article.url
      )
    ) {

      uniqueMap.set(
        article.url,
        article
      );
    }
  }


  allCandidates =
    Array.from(
      uniqueMap.values()
    );


  /* =======================================================
     ★Geminiへ送る候補を30件に制限
  ======================================================= */

  allCandidates =
    allCandidates.slice(
      0,
      CONFIG.MAX_CANDIDATES
    );


  console.log(
    `📚 Geminiへ送信する候補: ${allCandidates.length}件`
  );


  if (
    allCandidates.length ===
    0
  ) {

    console.log(
      '⚠️ ニュース候補がありません'
    );

    return;
  }


  /* =======================================================
     Gemini記事生成
  ======================================================= */

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

    /*
     * ================================================
     * ★429の場合
     * ================================================
     */

    if (
      isGeminiQuotaError(
        error
      )
    ) {

      console.warn(
        '⚠️ Gemini APIのクォータ制限に到達しました'
      );

      console.warn(
        '💬 ニュース記事の生成を停止し、一言つぶやきへ切り替えます'
      );


      try {

        await postFallbackTweet(
          token
        );

        /*
         * ★重要
         *
         * 429はBot自体の致命的エラーではないため、
         * process.exit(1)にしない。
         */

        console.log(
          '🏁 429フォールバック処理完了'
        );

        return;

      } catch (fallbackPostError) {

        /*
         * Firebase側のエラーなら
         * これは本当の失敗として扱う。
         */

        throw new Error(
          `429時のつぶやき投稿にも失敗しました: ${fallbackPostError.message}`
        );
      }
    }


    /*
     * ================================================
     * その他のGeminiエラー
     * ================================================
     */

    console.error(
      `❌ 記事生成失敗: ${error.message}`
    );

    throw error;
  }


  console.log(
    `🤖 Geminiが ${articles.length}件の記事を生成`
  );


  /* =======================================================
     記事をFirebaseへ投稿
  ======================================================= */

  let posted =
    0;


  const existingUrls =
    new Set(
      existingArticles
        .map(
          item =>
            item.url
        )
        .filter(Boolean)
    );


  for (
    const article
    of articles
  ) {

    try {

      /* ===================================================
         出典検証
      =================================================== */

      const validSources =
        validateSources(
          article,
          allCandidates
        );


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


      /* ===================================================
         過去記事との重複確認
      =================================================== */

      const alreadyPosted =
        article.sources.some(
          source =>
            existingUrls.has(
              source.url
            )
        );


      if (
        alreadyPosted
      ) {

        console.log(
          `⏭️ 既存ニュースと重複: ${article.title}`
        );

        continue;
      }


      /* ===================================================
         投稿
      =================================================== */

      await postToFirebase(
        token,
        article
      );


      posted++;


      /*
       * 連続投稿間隔
       */

      await sleep(
        3000
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


/* =========================================================
   実行
========================================================= */

main()
  .catch(
    error => {

      console.error(
        '致命的エラー:',
        error
      );

      process.exit(
        1
      );
    }
  );