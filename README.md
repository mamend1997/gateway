# WhatsApp Gateway

Gateway WhatsApp sederhana berbasis Node.js, Express, dan Baileys. Gunakan hanya untuk mengirim pesan yang memang diharapkan penerimanya dan patuhi kebijakan WhatsApp serta hukum yang berlaku.

## Persyaratan

- Node.js 20 atau lebih baru
- WhatsApp pada ponsel untuk menautkan perangkat melalui QR

## Instalasi dan menjalankan di VS Code

Buka folder proyek di VS Code, lalu siapkan dependensi dan file konfigurasi di terminal:

```powershell
npm install
Copy-Item .env.example .env
```

Isi `API_KEY` di `.env` dengan token acak yang panjang. Jangan gunakan nilai contoh pada deployment. Setelah itu:

```powershell
npm start
```

Untuk mode pengembangan dengan restart otomatis: `npm run dev`. Buka `http://localhost:3000`, masukkan API key, lalu scan QR dari menu **Perangkat tertaut** di WhatsApp. API key dashboard secara default hanya disimpan selama tab terbuka. Agar tidak perlu memasukkannya lagi, pilih **Ingat API key di perangkat ini** sebelum menekan **Simpan**. Ini menyimpan key di penyimpanan browser pada perangkat tersebut; gunakan hanya pada perangkat pribadi. Tombol **Keluar** menghapus key tersimpan.

Dependensi dan skrip sudah dicantumkan di `package.json`; setelah menyalin proyek, `npm install` saja sudah cukup. Jangan jalankan `npm init -y` pada proyek ini karena perintah itu hanya untuk inisialisasi folder kosong.

Jika memang membuat proyek baru dari folder kosong sebelum menyalin/menulis berkas aplikasi, perintah bootstrap yang diminta adalah:

```powershell
npm init -y
npm install express @whiskeysockets/baileys qrcode dotenv cors pino libphonenumber-js
```

## Konfigurasi

Salin `.env.example` menjadi `.env` dan atur:

| Variabel | Keterangan |
| --- | --- |
| `PORT` | Port HTTP; Railway menyediakan nilainya otomatis. |
| `API_KEY` | Wajib. Kunci admin untuk dashboard dan seluruh pengelolaan API. |
| `AUTH_DIR` | Folder kredensial semua device Baileys; arahkan ke volume persisten pada Railway. |
| `DATA_DIR` | Penyimpanan daftar device, token per-device, jadwal, aturan/cooldown auto-reply, kuota, cache nomor tidak aktif, logo, dan riwayat. Gunakan volume persisten pada Railway. |
| `ADMIN_PHONE` | Opsional, nomor admin format internasional. Setelah koneksi pulih, gateway mencoba mengirim notifikasi bahwa koneksi sempat terputus. |
| `CORS_ORIGIN` | Origin web yang boleh memanggil API, dipisahkan koma. Default `*`; untuk produksi, batasi ke origin aplikasi Anda. |
| `MIN_SEND_DELAY_MS` / `MAX_SEND_DELAY_MS` | Batas jeda acak antar pesan. Default 3000–7000 ms. |
| `MAX_RETRIES` | Jumlah retry setelah percobaan pertama. Default 2. |
| `MAX_MESSAGES_PER_MINUTE` / `MAX_MESSAGES_PER_DAY` | Kuota konservatif per device; default 10/menit dan 100/hari (UTC). Batas ini bukan jaminan aman dari pembatasan WhatsApp. |
| `DUPLICATE_WINDOW_MS` | Jeda pencegah duplikasi tujuan+konten; default 5 menit. |
| `BATCH_COOLDOWN_EVERY` | Istirahat setelah jumlah pesan massal berhasil; default 25. Nilai `0` menonaktifkannya. |
| `BATCH_COOLDOWN_MIN_MS` / `BATCH_COOLDOWN_MAX_MS` | Rentang istirahat batch; default 25–45 detik. |
| `AUTO_REPLY_COOLDOWN_MS` | Maksimal satu balasan otomatis per kontak/device selama default 10 menit. |
| `AI_AUTO_REPLY` | Set `true` untuk mengaktifkan balasan Gemini pada chat pribadi yang tidak cocok dengan aturan kata kunci. |
| `GEMINI_API_KEY` | Kunci API Gemini; simpan hanya sebagai secret Railway atau `.env` lokal. |
| `GEMINI_MODEL` | Model Gemini; default `gemini-2.5-flash`. |
| `AI_SYSTEM_PROMPT` | Opsional, konteks dan instruksi layanan untuk asisten AI. |

Sesi device utama tersimpan langsung di `AUTH_DIR`; device tambahan disimpan di subfoldernya. Daftar device, token per-device, jadwal, aturan auto-reply, dan riwayat disimpan di `DATA_DIR`. Pastikan kedua folder dipasang pada penyimpanan persisten di Railway. Token device disimpan dengan izin file terbatas; jangan bagikan token/API key atau QR kepada pihak lain. Jika WhatsApp menyatakan sesi utama logout (bukan sekadar koneksi terputus), hentikan service, hapus file sesi di `AUTH_DIR` secara manual, lalu jalankan ulang dan scan QR baru. Sesi device tambahan dapat dihapus dari menu **Devices**.

## REST API

API admin (`API_KEY`) dapat mengakses seluruh endpoint. Token unik per device hanya dapat mengirim pesan melalui device pemiliknya. Keduanya dikirim melalui salah satu header:

```http
x-api-key: <API_KEY>
```

Jangan menanam API key gateway di JavaScript frontend publik. Untuk aplikasi web yang digunakan banyak orang, simpan key di backend aplikasi tersebut dan panggil gateway melalui backend/proxy.

atau:

```http
Authorization: Bearer <API_KEY>
```

### Status koneksi

`GET /api/status` mengembalikan status `connecting`, `open`, atau `close`, flag `connected`, QR (data URL saat tersedia), dan pesan error terakhir.

### Kirim pesan

`POST /api/send-message` memvalidasi/menormalkan nomor, lalu mengembalikan HTTP `202` dan ID pekerjaan. Gunakan salah satu field nomor `phone`, `target`, atau `number`:

```json
{"target":"{phone}","message":"{message}"}
```

```json
{"phone":"{phone}","message":"{message}"}
```

Endpoint ini juga menerima `application/x-www-form-urlencoded`, jadi dapat dipasang pada form gateway web seperti berikut:

- **URL Gateway:** `https://gateway-production-a1168195.up.railway.app/api/send-message`
- **Token / API Key:** salin token device lewat tombol **Token** pada halaman **Devices**. `API_KEY` Railway juga dapat digunakan sebagai token admin.
- **Format body:** `form-urlencoded (target, message)`
- **Header otorisasi:** `Authorization: <TOKEN>` atau `Authorization: Bearer <TOKEN>`

Token device membatasi akses hanya ke endpoint pengiriman dan device yang bersangkutan; body cukup berisi `target` dan `message`. Token disimpan pada `DATA_DIR`. Tombol **Ganti token** langsung membatalkan token lama. Pastikan endpoint dan domain sesuai deployment aktif Anda. Jangan tempelkan token asli ke kode frontend publik.

Contoh `curl`:

```bash
curl -X POST "https://<nama-proyek>.up.railway.app/api/send-message" \
  -H "Content-Type: application/json" \
  -H "x-api-key: <API_KEY>" \
  -d '{"target":"6281234567890","message":"Halo"}'
```

Contoh `fetch`:

```js
const response = await fetch("https://<nama-proyek>.up.railway.app/api/send-message", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer <API_KEY>"
  },
  body: JSON.stringify({ phone: "081234567890", message: "Halo" })
});
const result = await response.json();
```

`GET /api/messages` mengembalikan hingga 1000 pesan terbaru beserta waktu, nomor/grup, cuplikan pesan, status, jumlah percobaan, lampiran, dan error. Riwayat ditulis ke `DATA_DIR/messages.json`; isi pesan lengkap dan file lampiran tidak disimpan di riwayat. Jika gateway berhenti saat ada pesan yang masih `queued`/`sending`, entri itu tetap terlihat dan ditandai gagal-terputus setelah restart agar tidak terkirim ganda.

### Dashboard dan fitur tambahan

- **Devices** mengelola beberapa sesi WhatsApp. Setiap device tambahan memerlukan QR scan tersendiri. Sesi yang sudah ada sebelumnya tetap menjadi **Perangkat utama**. Tombol **Token** menyalin token khusus device; **Ganti token** langsung membatalkan token lama.
- **Pesan Masal** menerima daftar nomor manual, kontak yang disinkronkan WhatsApp, grup, atau file Excel `.xlsx` dengan nomor di kolom bernama `phone`, `number`, `nomor`, `target`, `jid`, atau kolom pertama. Satu batch dibatasi 500 tujuan.
- Pesan massal dapat menyertakan hingga 5 gambar/PDF (masing-masing maksimal 16 MB). File dikirim sebagai pesan media terpisah; teks menjadi caption file pertama. Jeda batch mengatur laju antrean.
- Gunakan `{name}` dan `{phone}` untuk personalisasi pesan massal. Spintax/pengacakan variasi untuk menyamarkan pola pesan tidak disediakan; kirim hanya pesan relevan kepada penerima yang menyetujuinya.
- **Jadwal Pesan** menyimpan pengiriman satu kali ke waktu mendatang. Jadwal yang tertunda diproses kembali setelah restart jika `DATA_DIR` persisten.
- **Auto Reply** mencocokkan kata kunci secara tidak peka huruf besar/kecil dan membalas pesan masuk yang berisi kata tersebut. Aturan dapat ditujukan ke semua device atau satu device; setiap kontak dibatasi cooldown.
- **Balasan AI Gemini** (opsional) membalas chat pribadi yang tidak cocok dengan aturan kata kunci. Set `AI_AUTO_REPLY=true` dan isi `GEMINI_API_KEY`; balasan AI melewati antrean dan cooldown yang sama.
- **Pengamanan pengiriman** mencatat status `rate_limited`, `quota_exceeded`, dan `duplicate_suppressed`; kuota per-device disimpan di `DATA_DIR/message-quotas.json`. Jumlah pesan yang masih mengantre besar atau kuota habis ditampilkan di Pengaturan. Nomor yang tidak terdaftar dicache agar tidak terus dicek/dikirimi.
- **Logo & favicon** dapat diganti melalui Pengaturan dengan PNG, JPG, atau ICO maksimal 1 MB. File disimpan di `DATA_DIR`.
- **Riwayat Pesan** menyimpan 1000 entri terbaru lintas restart, termasuk status antrean dan percobaan pengiriman.

API tambahan (memerlukan `API_KEY` admin):

| Method dan path | Fungsi |
| --- | --- |
| `GET /api/devices` | Daftar device dan status koneksi |
| `POST /api/devices` (`{"name":"Admin"}`) | Membuat sesi WhatsApp baru |
| `DELETE /api/devices/:id` | Menghapus device tambahan beserta sesi lokalnya |
| `GET /api/devices/:id/contacts` / `groups` | Membaca kontak/grup device |
| `GET /api/devices/:id/token` | Membaca token device untuk disalin (hanya API admin) |
| `POST /api/devices/:id/token/rotate` | Mengganti token device (hanya API admin; token lama langsung tidak berlaku) |
| `GET /api/quota` | Sisa kuota dan peringatan keamanan per device |
| `GET /api/ai/status` | Status konfigurasi Gemini tanpa mengekspos API key |
| `POST`, `DELETE /api/settings/favicon` | Mengganti atau mengembalikan logo/favicon (API admin) |
| `POST /api/send-bulk` | Antrekan daftar tujuan sebagai batch |
| `POST /api/import-excel` | Impor file Excel dengan multipart field `file` |
| `GET`, `POST`, `DELETE /api/schedules` | Mengelola jadwal pesan |
| `GET`, `POST`, `PATCH`, `DELETE /api/auto-replies` | Mengelola aturan auto-reply |

`POST /api/send-bulk` menerima `multipart/form-data`: `targets` (JSON array), `deviceId`, `message`, `minDelaySeconds`, `maxDelaySeconds`, dan hingga lima field berulang `attachments`. Field tunggal `attachment` tetap didukung untuk kompatibilitas. Contoh sederhana tanpa lampiran:

```js
const form = new FormData();
form.append("targets", JSON.stringify(["081234567890", "6285712345678"]));
form.append("deviceId", "primary");
form.append("message", "Halo");
form.append("minDelaySeconds", "3");
form.append("maxDelaySeconds", "7");
// Opsional, pilih hingga lima file dari input multiple ber-ID "attachments".
for (const file of document.querySelector("#attachments").files) {
  form.append("attachments", file);
}
await fetch("https://<nama-proyek>.up.railway.app/api/send-bulk", {
  method: "POST",
  headers: { "x-api-key": "<API_KEY>" },
  body: form
});
```

## GitHub

`.gitignore` mengecualikan `.env`, `node_modules/`, dan direktori sesi. Periksa dulu dengan `git status` dan pastikan tidak ada kredensial yang sudah pernah dilacak.

```bash
git init
git add .
git commit -m "Initial WhatsApp Gateway"
git branch -M main
git remote add origin https://github.com/<user>/<repository>.git
git push -u origin main
```

Jangan pernah menjalankan `git add -f` untuk `.env` atau direktori autentikasi.

## Deploy ke Railway

1. Push repository ke GitHub dan buat project Railway dari repository tersebut. Build/start menggunakan `npm install` dan script `npm start`.
2. Pada **Variables**, atur `API_KEY` (nilai rahasia sendiri), `AUTH_DIR=/app/auth_info`, `DATA_DIR=/app/data`, `ADMIN_PHONE` bila perlu, dan `CORS_ORIGIN` ke origin frontend. Untuk AI, set `AI_AUTO_REPLY=true` dan `GEMINI_API_KEY` dari Google AI Studio. Railway mengatur `PORT` secara otomatis.
3. Pasang volume persisten pada `/app/auth_info` dan satu lagi pada `/app/data`, sama dengan `AUTH_DIR` dan `DATA_DIR`. Volume pertama menjaga sesi WhatsApp; volume kedua menjaga daftar device, token per-device, jadwal, auto-reply, dan riwayat lintas restart/redeploy.
4. Deploy. Buka URL publik service untuk dashboard, masukkan API key, lalu scan QR. Gunakan endpoint `https://<nama-proyek>.up.railway.app/api/send-message` dari aplikasi web eksternal dengan header API key.

Pada Railway, notifikasi admin tidak dapat dikirim ketika koneksi sedang putus; jika `ADMIN_PHONE` diisi, gateway mencoba mengirim pemberitahuan setelah koneksi tersambung kembali.

## Pengujian

```bash
npm test
```
