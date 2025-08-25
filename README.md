Some Improvemnt and Progress

day 1 progress bot

Info Bot
Dibuat dengan Baileys
Running di Node.js

Beberapa Prompt yang tersedia
halo/hai
ping
help/bantuan
info
myinfo
listfile
sendfile
filecount

Sistem OOP (Mendatang)
whatsapp-bot/
├── src/
│   ├── classes/
│   │   ├── Bot.js
│   │   ├── FileManager.js
│   │   ├── SecurityManager.js
│   │   └── WebServer.js
│   ├── utils/
│   │   └── helpers.js
│   └── index.js
├── auth_info/
├── received_files/
├── sent_files/
└── package.json

Plus
+ Send, read, list file
+ bisa ditambahkan beberapa program untuk fungsi yang akan mendatang
+ sudah dibatasi hanya account dengan nomor-nomor tertentu yang bisa mengakses
+ dapat membaca chat orang lain walaupun terkena restrict
+ dapat membuka file yang telah diterima ke dalam folder yang tersedia di vscode

Minus
- belum dicoba untuk beberapa account
- belum ditambahkan DB Local dibuatkan per-account agar bisa saling mengirimi file
- belum ditambahkan API yang berkaitan (tempat untuk mengoneksikan APInya)
- masih ada kekurangan jika, user yang diberikan akses mengirimkan data seperti png, jpg, dll tetap akan tersave walau tidak menyertakan propmpt
- dia tidak membaca file yang dikirim satu kali lihat dan chat serta grup yang terdapat diarsip WA
- hanya bisa digunakan digrup saja (kondisi detail ketika user mau ngirimkan file dan data kesuatu user itu harus masuk ke grup bebas baru bisa dibuka lagi digrup lainnya) intinya bot hanya dapat diakses melalui grup tidak bisa antar user secara langsung
- Ketika ada user yang akan atau baru saja masuk notif menyala walaupun pengguna bukan accessed user (dinonaktifkan dengan ctrl + /)

Sedang berjalan
* menambahkan sistem password ataupun hash kedalam file yang dikirimkan dari user-user tertentu
* menambahkan sistem untuk menghapus atau satu kali kirim (semisal user sudah mengirim file tertentu dengan target yg dia inginkan file tersebut akan mengirimkan view dan download setelah itu akan terhapus dari db
* menambahkan UI yang lebih bagus dalam halaman login ataupun akses untuk bot-bot
* menambahkan kondisi tertentu program tetap dapat berjalan seperti biasanya (maintance)
* mencoba untuk menambahkan output yang sama seperti accessed dan non-accessed
* mencoba untuk membuat bot tidak hanya dapat diakses melalui Group tapi juga dapat melalui direct message
* menambahkan sistem nonaktif sementara dikarenakan ini masih memakai local host jadi untuk skrg masih diaktifkan dan dinonaktifkan secara manual dan menyeluruh
* menambahkan fungsi yang dapat melihat text sudah terkirim, dan terbaca
* sistem tierlist highest rank more access for systems

yang ingin ditanyakan untuk progress kedepannya
? apakah bot ini akan dibuat satu bot untuk semua atau beberapa bot untuk beberapa orang
? mungkin menambahkan sistem non privacy ketika suatu user mengirimkan sesuatu bot akan mendownload file tsb tanpa sepengetahuan non accessed user
? apakah chat dari user ini mau dipisah2 sesuai grup atau hanya di keep untuk beberapa orang saja yang chatnya dissave
? apakah chat ataupun data yang mau dikirim harus dibuat tersembunyi tampa preview 
? jika bisa ataupun memungkinkan apakah dapat dibuat seperti prompt discord yang tidak terlihat promptnya tapi terlihat hasil outputnya sudah terkirim atau belumnya
