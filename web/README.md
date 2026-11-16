# نسخهٔ وب روی Netlify

این یک **وب‌اپ جداست**، نه همان اپ بومی. نه امضا می‌خواهد، نه نصب، نه تمدید ۷ روزه:
در Safari گوشی باز می‌شود. کار سنگین (ساخت لینک پخش) در یک تابع Netlify انجام می‌شود و
صدا در خود مرورگر با یک تگ `<audio>` پخش می‌شود.

---

## دو ریسکی که فقط یک دیپلوی واقعی جوابشان را می‌دهد

1. **آیا YouTube درخواست از IP دیتاسنتر Netlify را می‌پذیرد؟** (یا 403 / LOGIN_REQUIRED می‌دهد)
2. **آیا آدرسی که سرور Netlify می‌سازد، از گوشی پخش می‌شود؟** (وابستگی آدرس به IP سازنده)

لاگ داخل صفحه جواب هر دو را می‌دهد: `itag 140 @ rr?.googlevideo.com ipbits=0` و بعد
رویدادهای `<loadstart>`، `<playing>` یا `<error> code=…`.

---

## ساختار

- `netlify/functions/ytm.js` — تنها بک‌اند: جست‌وجوی ناشناس WEB_REMIX + پلیر VISIONOS
  (همان دو درخواست هستهٔ Rust).
- `public/` — صفحه، استایل، منطق پخش.
- `dist/worker.js` — همان چیزها در یک فایل تک‌تکه برای Cloudflare Workers
  (ساختهٔ `build-worker.mjs`؛ دستی ویرایشش نکن).
- `dev-server.mjs` — اجرای محلی روی شبکهٔ خانگی.
- `test/` — تست‌های آفلاین.
- `../netlify.toml` — تنظیمات دیپلوی Netlify در ریشهٔ مخزن (`base = "web"`).

---

## راه‌های انتشار

### راه اول (آسان‌ترین، بدون CLI و بدون گیت‌هاب): Cloudflare Workers

Cloudflare حساب را با ایمیل می‌سازد، رایگان است و کارت نمی‌خواهد. فقط یک فایل را در
مرورگر می‌چسبانی؛ نه نصب چیزی لازم است، نه اتصال به GitHub.

1. `dash.cloudflare.com` → **Sign up** با ایمیل (یا ورود).
2. منوی سمت چپ → **Workers & Pages** → **Create** → **Workers** →
   **Start with Hello World** → یک نام مثل `ytm-web` → **Deploy**.
3. **Edit code** → داخل ویرایشگر همهٔ کد نمونه را پاک کن → محتوای فایل
   `web/dist/worker.js` را بچسبان → **Deploy**.
4. بالای صفحه → **Settings** → **Variables and Secrets** → **Add**:
   - Name: `APP_KEY`
   - Value: یک رشتهٔ طولانی و تصادفی (مثلاً ۳۰ کاراکتر)
   - Type: **Secret**
   → **Save and deploy**.
5. آدرس Worker را باز کن: `https://<name>.<subdomain>.workers.dev`.
   بار اول Cloudflare یک subdomain از تو می‌خواهد؛ همان‌جا انتخابش کن.

محدودیت رایگان: ۱۰۰٬۰۰۰ درخواست در روز؛ برای این استفاده یعنی هیچ. اگر
`APP_KEY` را نگذاری، هر کسی که آدرس را بداند می‌تواند استفاده کند؛ برای استفادهٔ
شخصی حتماً بگذارش. (Cloudflare در ایران بدون VPN گاهی باز نمی‌شود؛ مثل خود یوتیوب
با VPN روشن استفاده کن.)

### راه دوم: Netlify CLI

ورود به Netlify با ایمیل یا گوگل انجام می‌شود، نه گیت‌هاب. خودِ آپلود از روی همین
کامپیوتر با ابزار رسمی Netlify انجام می‌شود.

```powershell
cd "C:\Users\NoteBook\Documents\Qoder\2026-11-16\d6110c31\ytm-ios-poc\web"
npx netlify-cli@latest login
npx netlify-cli@latest deploy --prod --dir=public --functions=netlify/functions
```

- دستور `login` یک مرورگر باز می‌کند؛ آنجا **Sign up** با ایمیل یا گوگل. رمز و
  کد را فقط خودت وارد می‌کنی.
- دستور `deploy` اگر سایت نداشته باشی می‌پرسد سایت تازه بسازد؛ **Create & configure
  a new site** را انتخاب کن و یک نام بده. آخرش آدرس `https://<name>.netlify.app` را
  چاپ می‌کند.
- بار اول دانلود CLI کمی طول می‌کشد و اگر شبکه ناپایدار باشد ممکن است از رجیستری
  رسمی قطع شود؛ در آن صورت `--registry=https://registry.npmmirror.com` را به دستور
  `npm install -g netlify-cli` اضافه کن.

بعد کلید را ست کن و یک بار دیگر همان deploy را بزن:

```powershell
npx netlify-cli@latest env:set APP_KEY "یک-رشته-طولانی-تصادفی"
npx netlify-cli@latest deploy --prod --dir=public --functions=netlify/functions
```

### راه سوم: Netlify از GitHub

1. `netlify.com` → **Sign up with GitHub**.
2. **Add new site** → **Import an existing project** → **GitHub** → **Authorize** →
   مخزن **Monfaredz/ytrtm**.
3. در **Build settings** چیزی پر نکن؛ `netlify.toml` در ریشهٔ مخزن `base`، `publish`
   و تابع‌ها را تعیین می‌کند → **Deploy site**.
4. بعد از دیپلوی، `APP_KEY` را در **Site configuration → Environment variables**
   بساز و از **Deploys → Trigger deploy** یک دیپلوی تازه بزن.

### باز کردن روی گوشی


1. سایت را در **Safari** باز کن → **Share** → **Add to Home Screen**.
2. آیکون را باز کن → دکمهٔ **کلید** (بالا، چپ) → همان مقدار `APP_KEY` را بچسبان → **ذخیره**.
   یک‌بار برای همیشه در `localStorage` می‌ماند. (یا یک‌بار آدرس را با `?key=...` باز کن.)

---

## تست روی گوشی

1. یک آهنگ جست‌وجو کن (مثلاً `blinding lights`).
2. یک نتیجه را بزن. لاگ باید خطی مانند `itag 140 @ rr?.googlevideo.com ipbits=0 expire=…`
   نشان دهد. اگر `no plain URL` آمد، مشکل کلاینت است نه شبکه.
3. دکمهٔ ▶ نوار پخش را بزن. **اولین پخش باید با لمس شروع شود** (محدودیت iOS).
4. اگر `<error> code=4` یا `waiting` و بعد توقف دیدی: سوییچ **HLS** را روشن کن؛
   آهنگ دوباره خودکار شروع می‌شود.
5. اگر باز هم نشد: **باز کردن لینک در تب** — Safari فایل را در تب تازه باز و پخش می‌کند.
6. در پایان **کپی لاگ** را بزن و متن را بفرست. لاگ هیچ چیز حساسی ندارد: نه آدرس کامل،
   نه اکانت، نه کلید.

---

## معنی نتیجه‌ها

- `<playing> t=0.0 …` → آدرس از خود گوشی پخش شد؛ ریسک وابستگی IP منتفی است.
- `<error> code=4` (SRC_NOT_SUPPORTED) → آدرس رد شد؛ اغلب به IP یا امضای آدرس مربوط است.
- `<error> code=2` (NETWORK) → شبکهٔ گوشی به googlevideo نرسید (VPN؟).
- «۱۲ ثانیه بدون پیشرفت» در لاگ → همان برش ۱ مگابایتی گوگل؛ HLS جوابش است.
- `resolve failed: HTTP 403` یا `LOGIN_REQUIRED` → **IP دیتاسنتر Netlify پذیرفته نشد**.
  این یعنی نسخهٔ وب روی Netlify کار نمی‌کند و باید تابع را جای دیگری برد (گزینه‌ها را
  جداگانه بررسی می‌کنیم).

---

## اجرای محلی

```
node web/dev-server.mjs
```

سپس `http://localhost:8890`. از گوشی در همان وای‌فای:
`http://<IP کامپیوتر>:8890`.

هشدار: در این حالت لینک‌ها با IP خانگی ساخته می‌شوند، نه IP Netlify؛ پس فقط ظاهر،
منطق و پخش را می‌سنجد. اگر کامپیوتر VPN دارد، گوشی هم باید همان مسیر را ببیند.

تست‌های آفلاین:

```
node --test web/test/ytm.test.mjs
```

---

## محدودیت‌ها

- پخش در پس‌زمینه: Safari معمولاً با قفل شدن صفحه ادامه می‌دهد، ولی کنترل‌های
  صفحهٔ قفل به کامل بودن اپ بومی نیستند.
- هدف فقط Safari روی iOS است؛ روی دسکتاپ هم باز می‌شود ولی تجربهٔ اصلی نیست.
- منطق resolve همان PoC است؛ اگر YouTube کلاینت visionOS را ببندد، هر دو مسیر
  (بومی و وب) با هم می‌خوابند.
- `noindex` و `APP_KEY` جلوی دیده‌شدن اتفاقی را می‌گیرند، ولی مرز امنیتی نیستند.

---

## نکتهٔ حقوقی

مثل قبل: برای استفادهٔ شخصی. توزیع عمومی چنین سرویسی خلاف شرایط YouTube است.
