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

Untuk mode pengembangan dengan restart otomatis: `npm run dev`. Buka `http://localhost:3000`, masukkan API key, lalu scan QR dari menu **Perangkat tertaut** di WhatsApp.

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
| `API_KEY` | Wajib. Kunci untuk seluruh endpoint `/api/*`, termasuk status dan QR. |
| `AUTH_DIR` | Folder kredensial Baileys; arahkan ke volume persisten pada Railway. |
| `ADMIN_PHONE` | Opsional, nomor admin format internasional. Setelah koneksi pulih, gateway mencoba mengirim notifikasi bahwa koneksi sempat terputus. |
| `CORS_ORIGIN` | Origin web yang boleh memanggil API, dipisahkan koma. Default `*`; untuk produksi, batasi ke origin aplikasi Anda. |
| `MIN_SEND_DELAY_MS` / `MAX_SEND_DELAY_MS` | Batas jeda acak antar pesan. Default 2000–4000 ms. |
| `MAX_RETRIES` | Jumlah retry setelah percobaan pertama. Default 2. |

Sesi tersimpan pada `AUTH_DIR`. Jangan hapus folder itu jika ingin mempertahankan login. QR dan seluruh API dilindungi API key; jangan bagikan QR maupun API key. Jika WhatsApp menyatakan sesi logout (bukan sekadar koneksi terputus), hentikan service, hapus isi folder `AUTH_DIR` secara manual, lalu jalankan ulang dan scan QR baru.

## REST API

Semua endpoint API memerlukan salah satu header:

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

`GET /api/messages` mengembalikan log terkini hingga 500 pesan beserta waktu, nomor, cuplikan pesan, status, jumlah percobaan, dan error. `onWhatsApp` memeriksa nomor sebelum pesan dikirim; nomor yang tidak terdaftar ditandai gagal tanpa retry.

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
2. Pada **Variables**, atur `API_KEY` (nilai rahasia sendiri), `AUTH_DIR=/app/auth_info`, `ADMIN_PHONE` bila perlu, dan `CORS_ORIGIN` ke origin frontend. Railway mengatur `PORT` secara otomatis.
3. Tambahkan **Volume** pada service dan set mount path ke `/app/auth_info`, sama dengan `AUTH_DIR`. Volume menjaga kredensial sesi lintas restart/redeploy; pastikan direktori tersebut hanya digunakan oleh service ini.
4. Deploy. Buka URL publik service untuk dashboard, masukkan API key, lalu scan QR. Gunakan endpoint `https://<nama-proyek>.up.railway.app/api/send-message` dari aplikasi web eksternal dengan header API key.

Pada Railway, notifikasi admin tidak dapat dikirim ketika koneksi sedang putus; jika `ADMIN_PHONE` diisi, gateway mencoba mengirim pemberitahuan setelah koneksi tersambung kembali.

## Pengujian

```bash
npm test
```
