// scripts/news-bot.js - KAT-TON AI 問題生成バックエンド
import fetch from 'node-fetch';

const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL;
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const NEWSBOT_EMAIL = process.env.NEWSBOT_EMAIL;
const NEWSBOT_PASSWORD = process.env.NEWSBOT_PASSWORD;

// ── Firebase Auth
async function getToken() {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
    { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ email: NEWSBOT_EMAIL, password: NEWSBOT_PASSWORD, returnSecureToken: true }) }
  );
  const d = await res.json();
  if (!d.idToken) throw new Error('Firebase Auth失敗: ' + (d.error?.message || ''));
  return d.idToken;
}

// ── Firebase DB read/write
async function dbGet(path, token) {
  const res = await fetch(`${FIREBASE_DB_URL}/${path}.json?auth=${token}`);
  return res.json();
}
async function dbSet(path, data, token) {
  await fetch(`${FIREBASE_DB_URL}/${path}.json?auth=${token}`, {
    method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data)
  });
}
async function dbUpdate(path, data, token) {
  await fetch(`${FIREBASE_DB_URL}/${path}.json?auth=${token}`, {
    method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data)
  });
}
async function dbDelete(path, token) {
  await fetch(`${FIREBASE_DB_URL}/${path}.json?auth=${token}`, { method: 'DELETE' });
}

// ── Gemini API呼び出し（テキストのみ）
async function geminiText(prompt) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ contents:[{ parts:[{ text: prompt }] }],
        generationConfig:{ temperature:0.7, maxOutputTokens:8000 } }) }
  );
  const d = await res.json();
  if (!res.ok) throw new Error(`Gemini失敗 ${res.status}: ${JSON.stringify(d.error)}`);
  return d.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ── Gemini API呼び出し（ファイル付き）
async function geminiWithFiles(prompt, files) {
  const parts = [];
  for (const f of files) {
    const base64 = f.data.split(',')[1] || f.data;
    if (f.type.startsWith('image/')) {
      parts.push({ inline_data: { mime_type: f.type, data: base64 } });
    } else if (f.type === 'application/pdf') {
      parts.push({ inline_data: { mime_type: 'application/pdf', data: base64 } });
    } else {
      // テキスト系はbase64デコードしてテキストとして送る
      try {
        const text = Buffer.from(base64, 'base64').toString('utf-8');
        parts.push({ text: `ファイル名: ${f.name}\n\n${text}` });
      } catch(e) {
        parts.push({ text: `ファイル名: ${f.name}` });
      }
    }
  }
  parts.push({ text: prompt });

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ contents:[{ parts }],
        generationConfig:{ temperature:0.7, maxOutputTokens:8000 } }) }
  );
  const d = await res.json();
  if (!res.ok) throw new Error(`Gemini失敗 ${res.status}: ${JSON.stringify(d.error)}`);
  return d.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ── JSONを安全に抽出
function extractJSON(text) {
  const first = text.indexOf('{'), last = text.lastIndexOf('}');
  if (first === -1 || last === -1) throw new Error('JSONが見つかりません');
  return JSON.parse(text.slice(first, last + 1));
}

// ── 資料解析（初回のみ）
async function analyzeFiles(files) {
  const prompt = `以下の資料を詳しく解析してください。

JSONのみで回答してください（前置き・コードブロック不要）:
{
  "summary": "資料の概要（300文字程度）",
  "topics": ["トピック1", "トピック2"],
  "keywords": ["キーワード1", "キーワード2"],
  "importantPoints": ["重要ポイント1", "重要ポイント2"],
  "facts": ["事実・数値・定義などの具体的な情報1", "2"],
  "definitions": ["用語: 定義", "用語2: 定義2"]
}`;

  const text = await geminiWithFiles(prompt, files);
  return extractJSON(text);
}

// ── 問題生成（解析結果から）
async function generateQuestions(analysis, qCount) {
  const analysisText = JSON.stringify(analysis, null, 2);
  const prompt = `以下の資料解析データから${qCount}問の四択クイズを作成してください。

資料解析データ:
${analysisText}

JSONのみで回答（前置き・コードブロック不要）:
{"questions":[{"q":"問題文","choices":["A. 選択肢1","B. 選択肢2","C. 選択肢3","D. 選択肢4"],"answer":0,"explanation":"解説"}]}

- answerは0〜3（正解のchoicesインデックス）
- 選択肢はA.B.C.D.で始める
- 資料の内容から満遍なく出題する
- 問題数は${qCount}問`;

  const text = await geminiText(prompt);
  const parsed = extractJSON(text);
  if (!Array.isArray(parsed.questions) || !parsed.questions.length) {
    throw new Error('問題が生成されませんでした');
  }
  return parsed.questions;
}

// ── メイン処理
async function main() {
  console.log('🤖 KAT-TON AI バックエンド起動');
  const token = await getToken();
  console.log('✅ Firebase認証完了');

  // processingJobsを取得
  const jobs = await dbGet('processingJobs', token);
  if (!jobs) { console.log('📭 処理待ちジョブなし'); return; }

  const pendingJobs = Object.entries(jobs)
    .filter(([, j]) => j.status === 'pending')
    .sort((a, b) => (a[1].requestedAt || 0) - (b[1].requestedAt || 0));

  if (!pendingJobs.length) { console.log('📭 pendingジョブなし'); return; }

  console.log(`📋 pendingジョブ: ${pendingJobs.length}件`);

  for (const [jobId, job] of pendingJobs) {
    console.log(`\n🔄 ジョブ処理: ${jobId} / チーム: ${job.teamId}`);

    // ジョブをprocessingに更新
    await dbUpdate(`processingJobs/${jobId}`, { status: 'processing', startedAt: Date.now() }, token);

    // 対応するquizSetを見つける
    const quizSets = await dbGet(`quizSets/${job.teamId}`, token);
    const qsEntry = quizSets
      ? Object.entries(quizSets).find(([, qs]) => qs.jobId === jobId)
      : null;
    const qsId = qsEntry?.[0];

    if (qsId) {
      await dbUpdate(`quizSets/${job.teamId}/${qsId}`, { status: 'processing' }, token);
    }

    try {
      let analysis;

      // 解析済みデータがあれば再利用
      if (job.hasExistingAnalysis) {
        console.log('♻️ 既存解析データを再利用');
        const matData = await dbGet(`materials/${job.teamId}/${job.materialHash}`, token);
        analysis = matData?.analysis;
        if (!analysis) throw new Error('解析データが見つかりません');
      } else {
        // 初回解析
        console.log('📄 資料を解析中...');
        if (!job.files || !job.files.length) throw new Error('ファイルがありません');
        analysis = await analyzeFiles(job.files);
        console.log('✅ 解析完了');

        // materials/{teamId}/{hash} に保存
        await dbSet(`materials/${job.teamId}/${job.materialHash}`, {
          analyzed: true,
          analysis,
          fileNames: job.files.map(f => f.name),
          analyzedAt: Date.now()
        }, token);
        console.log('💾 解析結果を保存');
      }

      // 問題生成
      console.log(`🤖 ${job.qCount}問を生成中...`);
      const questions = await generateQuestions(analysis, job.qCount);
      console.log(`✅ ${questions.length}問生成完了`);

      // quizSetに問題を保存
      if (qsId) {
        await dbUpdate(`quizSets/${job.teamId}/${qsId}`, {
          status: 'completed',
          questions,
          completedAt: Date.now()
        }, token);
        console.log(`💾 quizSet保存: ${qsId}`);
      }

      // ジョブを完了に
      await dbUpdate(`processingJobs/${jobId}`, { status: 'completed', completedAt: Date.now() }, token);

      // 古いファイルデータは削除（容量節約）
      await dbUpdate(`processingJobs/${jobId}`, { files: null }, token);

      console.log(`✅ ジョブ完了: ${jobId}`);

    } catch(e) {
      console.error(`❌ ジョブ失敗: ${jobId} - ${e.message}`);
      await dbUpdate(`processingJobs/${jobId}`, { status: 'failed', error: e.message }, token);
      if (qsId) {
        await dbUpdate(`quizSets/${job.teamId}/${qsId}`, { status: 'failed', error: e.message }, token);
      }
    }
  }

  console.log('\n🏁 全ジョブ処理完了');
}

main().catch(e => { console.error('致命的エラー:', e.message); process.exit(1); });
