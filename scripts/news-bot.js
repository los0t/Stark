// scripts/news-bot.js
import fetch from 'node-fetch';
import { parseStringPromise } from 'xml2js';

const CONFIG = {
  // 1回の実行で投稿する記事数
  MAX_ARTICLES: 1,

  // 1記事につき最低2つの出典
  MIN_SOURCES: 2,

  // 使用するGeminiモデル
  MODEL: 'gemini-3.6-flash',

  // 最初にRSSから集める候補数
  MAX_CANDIDATES: 100,

  // Google検索で集める関連Web記事数
  MAX_RELATED_SOURCES: 50,

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

async function generateArticles(
  candidates,
  existingArticles
) {

  const previousTitles = existingArticles
    .map(article => article.title)
    .filter(Boolean)
    .slice(-100);


  /* =======================================================
     最初の100件
  ======================================================= */

  const candidateText = candidates
    .slice(0, CONFIG.MAX_CANDIDATES)
    .map((article, index) => {

      return `
---RSS候補 ${index + 1}---

媒体: ${article.source}
タイトル: ${article.title}
公開日時: ${article.pubDate}
URL: ${article.url}

概要:
${article.description}
`;

    })
    .join('\n');


  /* =======================================================
     第1段階
     
     100件から「最も興味深い話題」を1つ選ぶ
  ======================================================= */

  const selectionPrompt = `
あなたは「Ecstasy」という日本語SNSのニュース編集AIです。

以下には複数のRSSから取得した最大100件のニュース候補があります。

この中から、

「日本の若者が最も興味を持ちそう」
「何それ？と思わせる」
「複数の記事を調べる価値がある」
「ニュースとして記事化する価値が高い」

という基準で、最も興味深いニュースを1つだけ選んでください。

重要：

・ニュース候補に存在する出来事だけを選ぶ
・架空のニュースを作らない
・すでに過去に投稿したニュースは避ける
・単なる一般的なニュースより、話題性の高い出来事を優先する
・重大事件については特に慎重に判断する

【過去の記事】

${previousTitles.join('\n')}

【RSSニュース候補】

${candidateText}

必ずJSONだけを返してください。

{
  "topic": "選んだニュースの話題",
  "reason": "なぜこの話題を選んだのか"
}
`;


  /* =======================================================
     第1段階 Gemini API
  ======================================================= */

  const selectionRes = await fetch(
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
                text: selectionPrompt
              }
            ]
          }
        ],

        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 2000,
          responseMimeType: 'application/json'
        }
      })
    }
  );


  const selectionData =
    await selectionRes.json();


  if (!selectionRes.ok) {
    throw new Error(
      'Gemini API失敗: ' +
      JSON.stringify(selectionData)
    );
  }


  const selectionText =
    selectionData
      .candidates?.[0]
      ?.content?.parts?.[0]
      ?.text;


  if (!selectionText) {
    throw new Error(
      'Geminiから話題選択結果が返されませんでした'
    );
  }


  let selected;


  try {

    let cleaned =
      selectionText.trim();

    cleaned = cleaned
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    const firstBrace =
      cleaned.indexOf('{');

    const lastBrace =
      cleaned.lastIndexOf('}');

    if (
      firstBrace !== -1 &&
      lastBrace !== -1 &&
      lastBrace > firstBrace
    ) {
      cleaned =
        cleaned.slice(
          firstBrace,
          lastBrace + 1
        );
    }

    selected =
      JSON.parse(cleaned);

  } catch (error) {

    console.error(
      'Gemini話題選択結果:',
      selectionText
    );

    throw new Error(
      'Geminiの話題選択JSON解析に失敗しました'
    );
  }


  if (!selected.topic) {
    throw new Error(
      'Geminiが話題を選択できませんでした'
    );
  }


  console.log(
    `🎯 選択された話題: ${selected.topic}`
  );

  console.log(
    `💡 選択理由: ${selected.reason || ''}`
  );


  /* =======================================================
     第2段階
     
     Google検索で関連する記事を最大50件探す
  ======================================================= */

  const searchPrompt = `
以下のニュースについて、最新かつ信頼できる情報をGoogle検索で調査してください。

【調査対象】

${selected.topic}

目的：

このニュースについて記事を書くために、
関連するWeb上の記事・報道をできるだけ多く探してください。

最大50件程度の関連情報源を使用してください。

優先する媒体：

・BBC
・Reuters
・AP
・The Guardian
・CNN
・NBC
・ABC
・CBS
・Sky News
・その他の信頼できる報道機関

検索では、

・事件の発生
・日時
・場所
・関係人物
・経緯
・現在の状況
・公式発表
・複数媒体による報道
・背景

などを確認してください。

同じニュースを報じている記事は積極的に比較してください。

噂やSNSの未確認情報だけの記事は、信頼できる情報と区別してください。

架空の情報を作らないでください。
`;


  const searchRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',

      headers: {
        'Content-Type':
          'application/json'
      },

      body: JSON.stringify({

        contents: [
          {
            parts: [
              {
                text:
                  searchPrompt
              }
            ]
          }
        ],

        tools: [
          {
            google_search: {}
          }
        ],

        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 7000
        }
      })
    }
  );


  const searchData =
    await searchRes.json();


  if (!searchRes.ok) {

    throw new Error(
      'Google検索付きGemini API失敗: ' +
      JSON.stringify(searchData)
    );
  }


  const searchedText =
    searchData
      .candidates?.[0]
      ?.content?.parts?.[0]
      ?.text;


  if (!searchedText) {

    throw new Error(
      'Google検索結果が返されませんでした'
    );
  }


  /* =======================================================
     Google検索結果から出典URL取得
  ======================================================= */

  const relatedSources = [];


  const groundingMetadata =
    searchData
      .candidates?.[0]
      ?.groundingMetadata;


  const groundingChunks =
    groundingMetadata
      ?.groundingChunks || [];


  for (
    const chunk
    of groundingChunks
  ) {

    const web =
      chunk.web;


    if (
      web &&
      web.uri &&
      web.title
    ) {

      if (
        !relatedSources.some(
          source =>
            source.url === web.uri
        )
      ) {

        relatedSources.push({

          name:
            web.title,

          url:
            web.uri

        });

      }

    }


    if (
      relatedSources.length >=
      CONFIG.MAX_RELATED_SOURCES
    ) {

      break;

    }

  }


  console.log(
    `🔎 Google検索から ${relatedSources.length}件の関連情報源を取得`
  );


  /* =======================================================
     RSS候補の出典も追加
  ======================================================= */

  for (
    const candidate
    of candidates
  ) {

    if (
      relatedSources.length >=
      CONFIG.MAX_RELATED_SOURCES
    ) {

      break;

    }


    /*
     * 選択された話題に関係する
     * RSS候補だけを追加する
     */

    const topicWords =
      selected.topic
        .toLowerCase()
        .split(/\s+/)
        .filter(
          word =>
            word.length >= 3
        );


    const candidateTextForMatch =
      `${candidate.title} ${candidate.description}`
        .toLowerCase();


    const matched =
      topicWords.length === 0 ||
      topicWords.some(
        word =>
          candidateTextForMatch.includes(
            word
          )
      );


    if (!matched) {
      continue;
    }


    if (
      !relatedSources.some(
        source =>
          source.url ===
          candidate.url
      )
    ) {

      relatedSources.push({

        name:
          candidate.source,

        url:
          candidate.url

      });

    }

  }


  /* =======================================================
     第3段階
     
     関連記事をまとめて1つの記事にする
  ======================================================= */

  const relatedSourceText =
    relatedSources
      .slice(
        0,
        CONFIG.MAX_RELATED_SOURCES
      )
      .map(
        (source, index) => {

          return `
---関連情報源 ${index + 1}---

媒体:
${source.name}

URL:
${source.url}
`;

        }
      )
      .join('\n');


  const finalPrompt = `
あなたは「Ecstasy」という日本語SNSのニュース編集AIです。

これから、1つのニュースについてGoogle検索などで発見した
複数の情報源をもとに、1本の完成したニュース記事を作成してください。


==================================================
【今回の記事テーマ】
==================================================

${selected.topic}


==================================================
【重要】
==================================================

これは「複数の記事をそのまま並べる」作業ではありません。

複数の報道を比較・照合し、

・共通して確認できる事実
・各報道で補足されている情報
・時系列
・背景
・現在の状況

を整理して、

「このニュースについて最も分かりやすくまとまった1本の記事」

を作ってください。


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
  信頼できる情報源で確認できる場合だけ使用する
・SNS上の未確認情報を事実として断定しない
・情報源同士で内容が食い違う場合は、断定を避ける
・古い情報と最新情報を混同しない


==================================================
【記事】
==================================================

400〜700文字程度。

自然な日本語のニュース記事にしてください。

可能な範囲で、

・何が起きたのか
・いつ起きたのか
・どこで起きたのか
・誰が関係しているのか
・なぜ話題になったのか
・現在どうなっているのか
・背景

を含めてください。


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
・過度に煽らない

こと。


==================================================
【出典】
==================================================

記事の内容を裏付ける情報源を最低2つ付けてください。

可能なら複数の異なる報道機関を使用してください。

出典URLは、

・Google検索で実際に発見されたURL
・RSS候補として与えられたURL

のどちらかだけを使用してください。

架空のURLは禁止です。


==================================================
【検索で発見された関連情報源】
==================================================

${relatedSourceText}


==================================================
【出力形式】
==================================================

必ずJSONだけを出力してください。

{
  "articles": [
    {
      "title": "記事の見出し",
      "summary": "400〜700文字程度の記事本文",
      "category": "海外事件",
      "sources": [
        {
          "name": "媒体名",
          "url": "実際の出典URL"
        },
        {
          "name": "媒体名",
          "url": "実際の出典URL"
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


  /* =======================================================
     第3段階 Gemini API
  ======================================================= */

  const finalRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',

      headers: {
        'Content-Type':
          'application/json'
      },

      body: JSON.stringify({

        contents: [
          {
            parts: [
              {
                text:
                  finalPrompt
              }
            ]
          }
        ],

        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 7000,

          responseMimeType:
            'application/json'
        }
      })
    }
  );


  const finalData =
    await finalRes.json();


  if (!finalRes.ok) {

    throw new Error(
      'Gemini記事生成API失敗: ' +
      JSON.stringify(finalData)
    );
  }


  const finalText =
    finalData
      .candidates?.[0]
      ?.content?.parts?.[0]
      ?.text;


  if (!finalText) {

    throw new Error(
      'Geminiから完成記事が返されませんでした'
    );
  }


  /* =======================================================
     JSON解析
  ======================================================= */

  let cleaned =
    finalText.trim();


  cleaned = cleaned
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();


  const firstBrace =
    cleaned.indexOf('{');


  const lastBrace =
    cleaned.lastIndexOf('}');


  if (
    firstBrace !== -1 &&
    lastBrace !== -1 &&
    lastBrace > firstBrace
  ) {

    cleaned =
      cleaned.slice(
        firstBrace,
        lastBrace + 1
      );

  }


  let result;


  try {

    result =
      JSON.parse(cleaned);

  } catch (error) {

    console.error(
      'Geminiの返答:',
      finalText
    );

    console.error(
      'JSON解析対象:',
      cleaned
    );

    throw new Error(
      'GeminiのJSON解析に失敗しました'
    );

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


  return result.articles
    .filter(article => {

      return (
        article &&
        article.title &&
        article.summary &&
        Array.isArray(
          article.sources
        )
      );

    })
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


  const validSources = [];


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
        `🌐 Google検索出典: ${source.name}`
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
   Firebaseへニュース投稿
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
     投稿済みニュースとして保存
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


  console.log(
    `✅ 投稿完了: ${displayTitle}`
  );


  console.log(
    `   出典数: ${article.sources.length}`
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


  /* Firebaseログイン */

  const token =
    await getFirebaseToken();


  /* 過去記事取得 */

  const existingArticles =
    await getExistingArticles(
      token
    );


  console.log(
    `📚 既存記事: ${existingArticles.length}件`
  );


  /* =======================================================
     複数RSSからニュース候補を取得
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


  /* URL重複削除 */

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


  /*
   * Geminiへ送る候補を100件までに制限
   */

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
     Geminiで記事生成
  ======================================================= */

  console.log(
    '🤖 100件から最も興味深い話題を選択中...'
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
    `🤖 完成記事: ${articles.length}件`
  );


  /* =======================================================
     記事をFirebaseへ投稿
  ======================================================= */

  let posted =
    0;


  for (
    const article
    of articles
  ) {

    try {

      /*
       * Google検索結果を含むため、
       * ここでは候補URLだけでなく
       * Geminiが返したURLを検証する。
       *
       * ただし、generateArticles内で
       * Google検索結果URLを保持しているため、
       * ここでは最低限のURL検証を行う。
       */

      const validSources =
        article.sources
          .filter(source => {

            if (
              !source ||
              !source.name ||
              !source.url
            ) {

              return false;

            }


            try {

              const url =
                new URL(
                  source.url
                );

              return (
                url.protocol ===
                  'http:' ||
                url.protocol ===
                  'https:'
              );

            } catch {

              return false;

            }

          })
          .filter(
            (source, index, array) =>
              array.findIndex(
                item =>
                  item.url ===
                  source.url
              ) === index
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

      const existingUrls =
        new Set(
          existingArticles
            .map(
              item =>
                item.url
            )
            .filter(Boolean)
        );


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


      /* 投稿 */

      await postToFirebase(
        token,
        article
      );


      posted++;


      /*
       * API連続実行を少し避ける
       */

      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            3000
          )
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

main().catch(
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