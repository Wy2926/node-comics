import type { Guide } from '../types';

export const localTranslationGuides: Guide[] = [
  {
    "slug": "local-translation",
    "title": "Terjemahan manga lokal: sambungkan manga-translator-ui ke NodeLane",
    "description": "Siapkan layanan Web manga-translator-ui, sambungkan ke NodeLane, dan terjemahkan halaman komik pertama Anda. Termasuk pemecahan masalah koneksi, login, menunggu dan cache.",
    "category": "Tutorial terjemahan lokal",
    "minutes": 8,
    "published": "2026-09-28",
    "updated": "2026-10-08",
    "related": [
      "local-manga-translator",
      "local-comics",
      "translation-troubleshooting"
    ],
    "sections": [
      {
        "title": "Sebelum Anda mulai",
        "paragraphs": [
          "NodeLane Comics menangani pembacaan di browser Anda; manga-translator-ui (MTU) memproses gambar. Saluran MTU Anda sendiri tidak memerlukan akun NodeLane dan tidak menggunakan kuota terjemahan resmi. Perangkat keras, model, dan biaya API pihak ketiga tetap menjadi milik Anda.",
          "Anda memerlukan ekstensi browser desktop terbaru, layanan MTU yang terinstal beserta dependensinya, serta nama pengguna dan kata sandi layanan tersebut. Tutorial ini menggunakan http://127.0.0.1:8000 di komputer yang sama dengan browser. Gunakan port Anda yang sebenarnya jika berbeda."
        ],
        "links": [
          {
            "label": "Unduh NodeLane Comics",
            "href": "/download/"
          },
          {
            "label": "Instalasi resmi MTU: Windows",
            "href": "https://hgmzhn.github.io/manga-translator-ui/en/install/windows-portable"
          },
          {
            "label": "Instalasi resmi MTU: Linux / macOS",
            "href": "https://hgmzhn.github.io/manga-translator-ui/en/install/linux-and-macos"
          }
        ]
      },
      {
        "title": "1. Mulai layanan Web MTU",
        "paragraphs": [
          "Ekstensi memerlukan layanan Web HTTP. Membuka jendela desktop MTU saja tidak cukup. Setelah menginstal MTU, jalankan perintah ini di direktori proyeknya dan biarkan layanan tetap berjalan. Lewati perintah ini jika Anda sudah menjalankan layanan Web melalui Docker atau metode lain.",
          "Contoh ini tidak mengaktifkan pemrosesan GPU. Tambahkan --use-gpu hanya setelah menyiapkan lingkungan GPU yang didukung sesuai dokumentasi resmi. Persyaratan model, driver, dan perangkat keras bergantung pada versi MTU."
        ],
        "code": "uv run --no-sync python -m manga_translator web --host 127.0.0.1 --port 8000",
        "links": [
          {
            "label": "Petunjuk peluncuran web resmi MTU",
            "href": "https://hgmzhn.github.io/manga-translator-ui/en/web/launch-and-access"
          }
        ]
      },
      {
        "title": "2. Terjemahkan gambar uji di MTU terlebih dahulu",
        "paragraphs": [
          "Buka http://127.0.0.1:8000 di browser Anda, selesaikan penyiapan akun MTU dan masuk. Jika memerlukan perubahan kata sandi awal, selesaikan di MTU sebelum menghubungkan ekstensi. Ini adalah kredensial MTU, terpisah dari akun NodeLane Anda.",
          "Konfigurasikan mesin penerjemah, model, dan kunci API yang diperlukan di server, lalu pastikan gambar uji menghasilkan gambar terjemahan. Ekstensi menetapkan bahasa tujuan dan memakai pengaturan bawaan server untuk opsi lainnya. Pastikan layanan Web menggunakan pengaturan bawaan yang Anda inginkan. Jangan memasukkan kunci API model ke kolom kata sandi ekstensi."
        ],
        "links": [
          {
            "label": "Proyek dan dokumentasi resmi MTU",
            "href": "https://github.com/hgmzhn/manga-translator-ui"
          }
        ]
      },
      {
        "title": "3. Tambahkan saluran terjemahan di ekstensi",
        "paragraphs": [
          "Buka pengaturan ekstensi dan temukan saluran Terjemahan. Setelah koneksi berhasil, ekstensi menyimpan kata sandi dan token layanan di komputer ini. Saat menghubungkan kembali dengan alamat layanan dan nama pengguna yang sama, kosongkan kolom kata sandi untuk menggunakan kata sandi yang tersimpan. Jika alamat atau nama pengguna berubah, atau kata sandi telah diubah atau tidak lagi valid, masukkan kata sandi lagi. Label di bawah menjelaskan kontrol yang sesuai dalam bahasa antarmuka Anda. Penyimpanan kata sandi dan koneksi ulang dengan kolom kosong memerlukan ekstensi 0.10.2 atau lebih baru; pada versi sebelumnya, masukkan kata sandi setiap kali menghubungkan ulang."
        ],
        "steps": [
          "Pilih Tambahkan saluran terjemahan dan konfirmasikan manga-translator-ui sebagai layanan. Secara opsional, beri nama yang dapat dikenali, seperti “Komputer saya”.",
          "Masukkan http://127.0.0.1:8000 sebagai alamat layanan. Gunakan root layanan, tanpa /auth/login, /translate/with-form/image atau jalur halaman administrasi.",
          "Masukkan nama pengguna dan kata sandi MTU, lalu pilih Hubungkan dan gunakan. Koneksi tidak meminta izin situs tambahan; jika akses dibatasi, pulihkan akses ke semua situs di pengaturan ekstensi lalu coba lagi.",
          "Periksa apakah Saluran saat ini menampilkan layanan baru. Anda dapat menyimpan beberapa profil layanan, namun hanya saluran yang dipilih yang digunakan pada satu waktu."
        ]
      },
      {
        "title": "4. Baca halaman terjemahan pertama Anda",
        "paragraphs": [
          "Impor komik lokal, buka EPUB, OPDS, atau situs yang didukung. Pilih bahasa tujuan dan aktifkan terjemahan. Ekstensi saat ini memakai terjemahan untuk saluran resmi maupun MTU.",
          "Gambar saat ini dan yang berdekatan diprioritaskan dalam jendela terbatas; di satu saluran MTU, gambar dijalankan satu per satu. Komik baru dibuka sebagai gambar asli dan terjemahan otomatis nonaktif secara default. Bandingkan tanpa kehilangan posisi; pembaca dan terjemahan halaman memakai saluran pilihan.",
          "Jika suatu halaman gagal, selesaikan masalah yang dilaporkan sebelum mencoba lagi secara manual. Menutup halaman atau kehilangan koneksi tidak membuktikan bahwa MTU menghentikan komputasi. Hindari pengiriman berulang-ulang saat layanan mungkin masih sibuk."
        ],
        "links": [
          {
            "label": "Mengimpor komik lokal dan format yang didukung",
            "href": "/guides/local-comics/"
          }
        ]
      },
      {
        "title": "Memecahkan masalah koneksi, login, dan menunggu lama",
        "paragraphs": [
          "Periksa MTU sendiri sebelum mencoba lagi ekstensi. Jangan membagikan kata sandi, token, atau file komik pribadi saat melaporkan masalah."
        ],
        "table": {
          "headers": [
            "Gejala",
            "Apa yang harus diperiksa"
          ],
          "rows": [
            [
              "Alamat layanan tidak terbuka",
              "Periksa apakah layanan Web berjalan dan port sudah benar. 127.0.0.1 berarti komputer yang menjalankan browser; perangkat lain memerlukan alamatnya sendiri yang dapat dijangkau."
            ],
            [
              "Halaman terbuka, tetapi ekstensi tidak dapat terhubung",
              "Periksa alamat root, izin akses browser, dan apakah versi MTU Anda menyediakan login akun yang kompatibel dan titik akhir terjemahan gambar."
            ],
            [
              "Kredensial salah atau perubahan kata sandi awal diperlukan",
              "Masuk ke MTU atau ubah kata sandi awal di sana, lalu sambungkan kembali. Gunakan kredensial MTU, bukan kata sandi NodeLane atau kunci model API."
            ],
            [
              "Koneksi sebelumnya sekarang melaporkan login yang kedaluwarsa",
              "Pilih Hubungkan kembali di pengaturan saluran. Untuk alamat layanan dan nama pengguna yang sama, kosongkan kolom kata sandi untuk menggunakan kata sandi yang tersimpan. Konfigurasi dari versi lama yang hanya menyimpan token memerlukan kata sandi sekali saat pertama kali dihubungkan kembali. Jika alamat atau nama pengguna berubah, atau kata sandi telah diubah atau tidak lagi valid, masukkan kata sandi lagi. Ekstensi tidak mengirimkan ulang terjemahan sebelumnya secara diam-diam. Penyimpanan kata sandi dan koneksi ulang dengan kolom kosong memerlukan ekstensi 0.10.2 atau lebih baru; pada versi sebelumnya, masukkan kata sandi setiap kali menghubungkan ulang."
            ],
            [
              "Terhubung, tetapi terjemahan masih menunggu",
              "Periksa unduhan model, pemuatan mesin, antrian, saldo API, dan sumber daya perangkat keras. Uji konfigurasi yang sama di MTU. Menghubungkan hanya memverifikasi login."
            ],
            [
              "Terganggu, kehabisan waktu, atau mengembalikan sesuatu selain gambar",
              "Periksa tugas MTU, batas waktu proxy, dan respons. Coba lagi halaman yang gagal secara manual setelah memperbaiki penyebabnya. Ekstensi tidak mengembalikan hasil secara otomatis dari riwayat MTU."
            ]
          ]
        }
      },
      {
        "title": "Cache, penggunaan offline, dan ke mana perginya gambar",
        "paragraphs": [
          "Hasil saluran lokal disimpan dalam cache di penyimpanan lokal browser ini. Menghapus cache, atau menyetel anggaran cache gambar terjemahan ke nol dan menutup halaman yang masih menyimpan hasil, dapat menghapusnya. Hasil yang hilang memerlukan terjemahan ulang manual; ekstensi tidak dapat mengambilnya kembali dari MTU.",
          "Gambar masuk ke layanan MTU yang dipilih. Menjalankan MTU secara lokal tidak menjamin terjemahan offline: penerjemah online, OCR, atau model gambar dapat mengirim teks atau gambar ke penyedia mereka. Pembuatan offline memerlukan ketersediaan model asli, model yang diunduh, dan pipeline tanpa ketergantungan online."
        ],
        "links": [
          {
            "label": "Terjemahan manga lokal: biaya, privasi, dan persyaratan offline",
            "href": "/guides/local-manga-translator/"
          }
        ]
      }
    ]
  },
  {
    "slug": "local-manga-translator",
    "title": "Memilih penerjemah manga lokal untuk membaca browser",
    "description": "Hubungkan manga-translator-ui ke pembaca browser: komik lokal, EPUB dan OPDS, biaya perangkat keras serta API, privasi, dan syarat terjemahan offline.",
    "category": "Panduan terjemahan lokal",
    "minutes": 6,
    "published": "2026-09-28",
    "updated": "2026-10-04",
    "related": [
      "local-translation",
      "translation-modes",
      "local-comics"
    ],
    "sections": [
      {
        "title": "Terjemahan manga memerlukan alur kerja gambar",
        "paragraphs": [
          "Dialog dalam manga biasanya merupakan bagian dari karya seni. Terjemahan teks browser tidak dapat secara langsung mengembalikan kata-kata yang diterjemahkan ke dalam gelembung ucapan. Terjemahan gambar mendeteksi teks, membacanya dengan OCR, menerjemahkannya, menghapus huruf asli dan menampilkan hasilnya.",
          "Jika Anda sudah memiliki komputer yang mampu menjalankan layanan terjemahan, Anda dapat menggunakan manga-translator-ui untuk pemrosesan gambar dan NodeLane Comics untuk membaca browser secara berkelanjutan. Ekstensi mengirimkan gambar dari jendela bacaan saat ini ke layanan yang dipilih dan menampilkan terjemahan yang dikembalikan pada tempatnya."
        ]
      },
      {
        "title": "Bacaan lokal, layanan lokal dan terjemahan offline",
        "paragraphs": [
          "“Lokal” dapat menggambarkan lokasi file atau tempat layanan dijalankan. Ikuti seluruh jalur pemrosesan untuk memahami apa yang terjadi pada konten."
        ],
        "table": {
          "headers": [
            "Istilah",
            "Apa artinya"
          ],
          "rows": [
            [
              "Membaca komik lokal",
              "Impor CBZ/ZIP, CBR/RAR, PDF, MOBI tanpa DRM yang didukung, atau EPUB. Gambar asli dibaca tanpa layanan terjemahan; di EPUB hanya gambar bitmap tertanam yang diterjemahkan."
            ],
            [
              "Layanan MTU lokal",
              "Gambar masuk ke instalasi MTU Anda, yang mungkin menggunakan model lokal atau API eksternal."
            ],
            [
              "Terjemahan sepenuhnya offline",
              "Dokumen asli, model, dan dependensi tersedia secara lokal, dan setiap tahap pemrosesan berfungsi tanpa layanan online. Verifikasi sendiri seluruh saluran pipa."
            ]
          ]
        }
      },
      {
        "title": "MTU yang dihosting sendiri atau saluran resmi?",
        "paragraphs": [
          "Saluran lokal cocok untuk pembaca yang sudah menjalankan MTU atau ingin mempertahankan model dan layanan mereka sendiri. Saluran resmi mengurangi pengaturan dan pemeliharaan. Cobalah beberapa halaman dengan salah satu opsi sebelum menilai hasilnya."
        ],
        "table": {
          "headers": [
            "Pertimbangan",
            "Saluran MTU Anda",
            "Saluran NodeLane resmi"
          ],
          "rows": [
            [
              "Akun",
              "MTU kredensial; tidak ada NodeLane masuk",
              "NodeLane diperlukan proses masuk"
            ],
            [
              "Pengaturan",
              "Instal, jalankan, dan konfigurasikan layanan Anda",
              "Layanan terjemahan dikelola oleh NodeLane"
            ],
            [
              "Biaya",
              "Tidak ada kuota resmi yang digunakan; perangkat keras, daya, dan API pilihan adalah milik Anda",
              "Rencana resmi dan aturan kuota"
            ],
            [
              "Cache hasil tidak ada",
              "Diperlukan terjemahan ulang manual",
              "Hasil resmi yang memenuhi syarat dapat diunduh lagi selagi tersedia"
            ]
          ]
        },
        "links": [
          {
            "label": "Hubungkan layanan lokal Anda",
            "href": "/guides/local-translation/"
          },
          {
            "label": "Rencana dan kuota resmi",
            "href": "/pricing/"
          }
        ]
      },
      {
        "title": "Apakah terjemahan manga lokal gratis? GPU mana yang Anda butuhkan?",
        "paragraphs": [
          "Terjemahan MTU tidak menggunakan kuota resmi NodeLane, namun hal tersebut tidak membuat keseluruhan alur kerja bebas biaya. Model online mungkin mengenakan biaya per permintaan; model lokal memerlukan perangkat keras, penyimpanan, dan waktu pemrosesan. Periksa mesin pilihan Anda sebelum memperkirakan biayanya.",
          "Tidak ada persyaratan memori tunggal untuk setiap pengaturan. Model, resolusi gambar, OCR, dan mesin inpainting memengaruhi penggunaan sumber daya dan waktu pemrosesan. Ikuti panduan instalasi MTU untuk sistem operasi dan perangkat keras Anda, lalu uji satu halaman yang jelas. Tidak ada kecepatan tetap atau kompatibilitas perangkat keras universal yang dijanjikan."
        ],
        "links": [
          {
            "label": "Proyek resmi MTU dan panduan instalasi",
            "href": "https://github.com/hgmzhn/manga-translator-ui"
          }
        ]
      },
      {
        "title": "Periksa manga Jepang, komik Korea, dan strip panjang",
        "paragraphs": [
          "Mulailah dengan dokumen asli yang jelas dan periksa apakah OCR yang dikonfigurasi mendukung bahasanya. Dialog vertikal, efek tulisan tangan, latar belakang yang rumit, dan pemindaian resolusi rendah dapat menyebabkan teks hilang. Strip vertikal yang besar mungkin juga memerlukan lebih banyak memori dan waktu.",
          "Pilih bahasa target yang tersedia dan bandingkan satu atau dua halaman terjemahan dengan aslinya. Periksa kelalaian, nama, nada dan tata letak gelembung. Hasil bergantung pada model dan pengaturan di MTU; koneksi lokal tidak dengan sendirinya meningkatkan akurasi terjemahan."
        ]
      },
      {
        "title": "Di mana gambar diunggah, dan apa yang berfungsi secara offline?",
        "paragraphs": [
          "Dengan memilih MTU, ekstensi mengirimkan gambar terjemahan langsung ke layanan yang dikonfigurasi tersebut, bukan melalui layanan terjemahan resmi NodeLane. Apakah MTU meneruskan teks atau gambar ke penyedia model bergantung pada mesin yang diaktifkan.",
          "Komik lokal yang diimpor dan terjemahan yang disimpan dalam cache tetap dapat dibaca selama sumber daya tersebut tersedia. Menghasilkan terjemahan baru secara offline memerlukan layanan lokal yang berjalan dan alur pemrosesan yang sepenuhnya offline. Situs web asli juga harus di-cache terlebih dahulu. Menyimpan cache hasil akan mengurangi pekerjaan yang berulang, namun cache bukanlah cadangan permanen."
        ],
        "links": [
          {
            "label": "Unggahan gambar dan izin ekstensi",
            "href": "/guides/comic-reader-privacy/"
          }
        ]
      },
      {
        "title": "Mulailah dengan satu halaman",
        "paragraphs": [
          "Mulai layanan Web MTU dan terjemahkan satu gambar dalam antarmukanya sendiri. Kemudian tambahkan alamat layanan dan akun di pengaturan NodeLane, sambungkan, dan pilih terjemahan dan bahasa target.",
          "Jika koneksi gagal, periksa alamat dan izin browser. Jika login berhasil tetapi tidak ada gambar yang muncul, periksa konfigurasi terjemahan layanan. Uji coba kecil memberi tahu Anda lebih banyak tentang kesesuaian untuk membaca sehari-hari dibandingkan klaim kecepatan umum."
        ],
        "links": [
          {
            "label": "Ikuti tutorial terjemahan lokal",
            "href": "/guides/local-translation/"
          },
          {
            "label": "Unduh pembaca komik dan penerjemah",
            "href": "/download/"
          }
        ]
      }
    ]
  }
];
