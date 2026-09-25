# Recap Studio v2 — စတင်အသုံးပြုနည်း

THET × DeepLearn AI · sign-in မလိုပါ — ဖွင့်ရင် editor ကို တန်းဝင်သွားပါမယ် — engine ကတော့ ကိုယ့် machine ထဲမှာပဲ run ပါတယ်

---

## ၁။ လိုအပ်တာ

- **Node.js 18+** — `node -v` နဲ့ စစ်ပါ။ မရှိရင် https://nodejs.org က LTS ကို install လုပ်ပါ။
- **AssemblyAI key** — transcription အတွက် (https://www.assemblyai.com)
- **Gemini key** — ဘာသာပြန်အတွက် (`AIza…` = Google တိုက်ရိုက်၊ တခြားဟာဆို OpenRouter key)
- ffmpeg ကို သီးသန့် install စရာ **မလိုပါ** — `ffmpeg-static` နဲ့ ပါလာပါတယ်။

---

## ၂။ Install (တစ်ခါတည်း)

Terminal ဖွင့်ပြီး —

```bash
cd "~/Downloads/be-recamp-main 2"

cd server && npm install && cd ..
cd client && npm install && cd ..
```

---

## ၃။ Font ထည့်ပါ (captions အတွက်)

မြန်မာ font တွေကို `server/fonts/` ထဲ ထည့်ပါ။ ရှိပြီးသားတွေကို ကူးထည့်ရင် —

```bash
cd "~/Downloads/be-recamp-main 2"
mkdir -p server/fonts
unzip -o server/logicFile/fonts.zip -d server/fonts
cp client/public/NotoSansMyanmar-Regular.ttf server/fonts/ 2>/dev/null
ls server/fonts
```

`server/fonts/` ထဲက font တွေက UI ရဲ့ **Subtitles → font picker** ထဲ အလိုလို ပေါ်လာပါမယ်။

---

## ၄။ Run

Terminal **နှစ်ခု** ဖွင့်ပါ။

Terminal 1 — engine:
```bash
cd "~/Downloads/be-recamp-main 2/server"
npm start
```

Terminal 2 — UI:
```bash
cd "~/Downloads/be-recamp-main 2/client"
npm run dev
```

ပြီးရင် browser မှာ **http://localhost:5173** ဖွင့်ပါ။

> Terminal တစ်ခုတည်းနဲ့ လုပ်ချင်ရင် — `cd client && npm run build` တစ်ခါ run ပြီးရင်
> `cd server && npm start` တစ်ခုတည်းနဲ့ **http://localhost:5001** မှာ ဖွင့်လို့ရပါတယ်။

---

## ၅။ ပထမဆုံး အသုံးပြုပုံ

0. Browser ဖွင့်ရင် editor ကို တန်းဝင်သွားပါမယ် — sign-in မလိုပါ။
1. ညာဘက်အပေါ်က **⚙ Settings** နှိပ်ပြီး AssemblyAI key + Gemini key ထည့်၊ Save။
   (key တွေက `server/settings.json` ထဲသာ သိမ်းပါတယ် — browser ထဲ မရောက်ပါ၊ user အားလုံး share လုပ်တဲ့ key ပါ)
2. ဗီဒီယိုကို ဘယ်ဘက် canvas ထဲ ဆွဲထည့်ပါ။
3. **Source** tab — mode ရွေးပါ
   - **Dubbing** — စကားပြောများတဲ့ ဗီဒီယို (dialogue)
   - **AI Recap** — narration / recap ဗီဒီယို (အသံက master၊ ဗီဒီယိုကို လိုက်ချိန်)
   ပြီးရင် ratio (9:16 စသည်) ရွေးပါ။
4. **Voice** tab — အသံ၊ voice speed (default +30%)၊ video speed ချိန်ပါ။
5. **Subtitles** tab — caption ပုံစံ၊ font၊ blur box၊ "Cover original subtitle"၊ watermark။
   Blur box ကို preview ပေါ်မှာ တိုက်ရိုက် ဆွဲ/ချဲ့လို့ရပါတယ် — ဆွဲထားတဲ့ box အတိုင်းအတာအတိုင်းပဲ ထွက်ပါမယ်။
6. **Start Processing** နှိပ်ပါ။

ပြီးရင် mp4 နဲ့ .srt နှစ်ခုလုံး download လုပ်လို့ရပါတယ်။ ဖိုင်တွေက `server/outputs/` ထဲမှာလည်း ရှိပါတယ်။

---

## ၆။ ကိုယ်တိုင် စစ်ဆေးဖို့ (API key မလို)

```bash
cd "~/Downloads/be-recamp-main 2/server"
node tools/verify.js
```

ဒါက စမ်းသပ် ဗီဒီယိုတစ်ခု ဖန်တီးပြီး blur + ratio + caption + render အားလုံးကို အဆုံးထိ run ကြည့်ပါတယ်။
နောက်ဆုံးမှာ A/V delta၊ caption အရေအတွက်၊ fps၊ ratio ကို ပြပါမယ် — အားလုံး `All checks passed.` ဖြစ်ရပါမယ်။

---

## ၇။ Claude Code နဲ့ ဆက်လုပ်ချင်ရင်

repo root မှာ **`CLAUDE.md`** ရှိပါတယ် — engine ရဲ့ ဘယ်အပိုင်းကို မထိရဘူး၊ blur/SRT/ratio/speed တွေ ဘယ်လို အလုပ်လုပ်တယ်၊
timing ပြင်ရင် ဘာတွေ စစ်ရမယ် ဆိုတာ အကုန်ရေးထားပါတယ်။ Claude Code ကို ဒီ folder ထဲမှာ ဖွင့်ရုံပါပဲ —
အဲဒီ file ကို အလိုလို ဖတ်ပါလိမ့်မယ်။

---

## ၈။ ပြဿနာတက်ရင်

| လက္ခဏာ | ဖြေရှင်းနည်း |
|---|---|
| "Server ကို မတွေ့ပါ" | `server` folder မှာ `npm start` run ထားလား စစ်ပါ |
| AssemblyAI error | key မှန်လား၊ credit ကုန်သွားလား စစ်ပါ |
| Gemini 403 | key ရဲ့ project မှာ billing ဖွင့်ထားဖို့ လိုပါတယ် (free tier က တခါတလေ ပိတ်တယ်) |
| Caption က font မပေါ်ဘဲ ခလုတ်တွေဖြစ် | `server/fonts/` ထဲ မြန်မာ font ထည့်ပြီးမှ ပြန် run ပါ |
| Render နှေးတယ် | Advanced tab မှာ **Draft** quality ရွေးပါ |

---

## ဘာတွေ ဖြုတ်လိုက်လဲ

MongoDB · admin dashboard · payment + Telegram · Cloudinary · free/premium limit ·
browser ffmpeg.wasm (server-side ffmpeg နဲ့ အစားထိုးလိုက်ပါပြီ — ပိုမြန်ပြီး ဗီဒီယိုအရှည် ကန့်သတ်ချက် မရှိတော့ပါ)

login/Google OAuth (Supabase Auth) ကို တစ်ချိန်တုန်းက ထည့်ခဲ့ပေမယ့် ပြန်ဖြုတ်လိုက်ပါပြီ — app ကို
sign-in မလိုအောင်၊ ဘယ်သူမဆို ချက်ချင်း အသုံးပြုလို့ရအောင် လုပ်ထားတာပါ (URL ရောက်တဲ့သူတိုင်း render
တင်ခွင့်ရှိတယ်၊ AssemblyAI/Gemini key ကို shared key အနေနဲ့ တွေ့/ပြင်ခွင့်ရှိတယ်ဆိုတာကို သတိထားပါ)။

အဟောင်းတွေကို `_legacy/` folder ထဲ ရွှေ့ထားပါတယ် — မလိုတော့ရင် ဖျက်လို့ရပါတယ်။
