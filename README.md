# NEXUS Video Saver — MVP Gratis

Backend Node.js + Express untuk UI NEXUS. MVP ini:
- Menyajikan frontend dari `public/index.html`.
- Mengambil metadata dan thumbnail melalui TikTok oEmbed resmi.
- Memeriksa URL file video langsung dan mencoba mengunduhnya.
- Membatasi request, ukuran file, timeout, redirect, dan akses ke IP privat.

**Penting:** TikTok oEmbed memberikan metadata/HTML embed, bukan MP4. Endpoint download hanya untuk URL file video langsung yang dapat diakses dan yang pengguna berhak menyimpannya. Tidak ada bypass login, private video, DRM, atau pembatasan akses.

## Struktur

```text
nexus-video-saver/
├── public/
│   └── index.html
├── server.js
├── package.json
├── .env.example
├── .gitignore
└── README.md
```

## Persyaratan

- Node.js 20 atau lebih baru
- npm
- VS Code (disarankan)

## Jalankan di VS Code

1. Ekstrak folder proyek.
2. Buka folder `nexus-video-saver` melalui VS Code.
3. Buka Terminal → New Terminal.
4. Jalankan:

   ```bash
   npm install
   npm run dev
   ```

5. Buka `http://localhost:3000`.
6. Tes kesehatan API dengan membuka `http://localhost:3000/api/health`.

Jika `npm run dev` tidak tersedia di lingkunganmu, gunakan `npm start`.

## Endpoint

### `GET /api/health`
Respons:
```json
{"ok":true,"service":"nexus-video-saver","mode":"mvp","time":"..."}
```

### `POST /api/metadata`
Body:
```json
{"url":"https://www.tiktok.com/@creator/video/1234567890"}
```
Mengembalikan judul, nama kreator, URL kreator, dan thumbnail dari TikTok oEmbed. Endpoint menolak host yang bukan TikTok. Link harus bisa diproses oEmbed; video privat/dihapus mungkin tidak tersedia.

### `POST /api/validate-video`
Body:
```json
{"url":"https://example.com/video.mp4"}
```
Memeriksa akses URL file langsung dengan Range request. Server menolak alamat privat/khusus, redirect yang tidak aman, dan URL yang bukan file video yang dikenali.

### `GET /api/download?url=https%3A%2F%2Fexample.com%2Fvideo.mp4`
Meneruskan file video langsung ke browser dengan `Content-Disposition: attachment`. Batas default 100 MB. Keberhasilan tetap bergantung pada server sumber, CORS tidak menentukan unduhan server-to-server, dan browser dapat mengatur lokasi simpanannya sendiri.

## Deploy gratis ke Render

1. Buat repository GitHub baru dan upload isi folder ini (jangan upload `.env` atau secret).
2. Di Render pilih **New → Web Service**, lalu hubungkan repository.
3. Isi:
   - **Runtime/Language:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free
4. Deploy. Render memberi URL seperti `https://nama-layanan.onrender.com`.
5. Buka `https://nama-layanan.onrender.com/api/health` untuk tes.
6. Frontend sudah memanggil endpoint relatif `/api/...`, jadi jika frontend dan backend disajikan oleh layanan ini, tidak perlu mengatur URL API terpisah.

Catatan paket gratis Render: layanan dapat tidur setelah sekitar 15 menit tanpa trafik dan perlu waktu untuk bangun lagi. Filesystem lokal bersifat sementara; riwayat frontend hanya disimpan di browser masing-masing, bukan database server.

## Keamanan & batasan

- Jangan menambahkan API key ke JavaScript frontend. Simpan secret hanya sebagai environment variable backend.
- Endpoint unduh memiliki rate limit, batas ukuran, timeout, redirect maksimal tiga hop, dan pemeriksaan DNS/IP untuk menolak alamat privat.
- Jangan gunakan server ini sebagai proxy umum atau untuk konten yang tidak kamu miliki/tidak diberi izin untuk disimpan.
- Untuk file besar, hosting gratis dapat memiliki batas memori, waktu, atau bandwidth. Ini MVP untuk percobaan, bukan layanan produksi.
- Tidak ada API key TikTok yang diperlukan untuk oEmbed. API ini tidak mengunduh MP4 dari link TikTok.
