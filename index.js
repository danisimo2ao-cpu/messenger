// =============================================================================
// МЕССЕНДЖЕР — ОДИН ФАЙЛ
// Установка: npm i express socket.io jsonwebtoken bcryptjs multer
// Запуск:    node index.js
// Функции:   чаты, группы, каналы, друзья, текст, фото, файлы, голос,
//            камера, аудио/видеозвонки (WebRTC), профиль, онлайн-статус
// =============================================================================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-' + crypto.randomBytes(16).toString('hex');
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
[DATA_DIR, UPLOADS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const DB_FILE = path.join(DATA_DIR, 'db.json');
const emptyDB = () => ({ users: [], friendships: [], chats: [], chat_members: [], messages: [] });
let db;
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { db = emptyDB(); }
Object.keys(emptyDB()).forEach(k => { if (!Array.isArray(db[k])) db[k] = []; });

let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
    catch (e) { console.error('save err', e); }
  }, 100);
}

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

// ---------- Uploads ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, f, cb) => cb(null, UPLOADS_DIR),
    filename: (req, f, cb) => cb(null, uid() + path.extname(f.originalname || '').slice(0, 10))
  }),
  limits: { fileSize: 100 * 1024 * 1024 }
});

// ---------- Express / Socket.io ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 1e7 });

app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(UPLOADS_DIR));

// ---------- Онлайн-статусы ----------
const onlineUsers = new Map(); // userId -> count

// =============================================================================
// КЛИЕНТ — HTML
// =============================================================================
const HTML = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Мессенджер</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<!-- AUTH -->
<div id="screen-auth" class="screen">
  <div class="auth-box">
    <h1>💬 Мессенджер</h1>
    <div class="tabs">
      <button class="tab active" data-tab="login">Вход</button>
      <button class="tab" data-tab="register">Регистрация</button>
    </div>
    <form id="form-login">
      <input name="email" type="email" placeholder="Email" required>
      <input name="password" type="password" placeholder="Пароль" required>
      <button type="submit">Войти</button>
      <div class="error" id="login-error"></div>
    </form>
    <form id="form-register" class="hidden">
      <input name="username" placeholder="Имя пользователя (a-z0-9_)" required pattern="[a-zA-Z0-9_]{3,32}">
      <input name="email" type="email" placeholder="Email" required>
      <input name="password" type="password" placeholder="Пароль 6+" required minlength="6">
      <button type="submit">Создать аккаунт</button>
      <div class="error" id="register-error"></div>
    </form>
  </div>
</div>

<!-- MAIN -->
<div id="screen-main" class="screen hidden">
  <aside class="sidebar">
    <div class="sidebar-header">
      <button class="icon-btn" id="btn-profile"><div class="avatar sm" id="my-avatar">?</div></button>
      <div class="sidebar-title" id="my-name">…</div>
      <div class="sidebar-actions">
        <button class="icon-btn" id="btn-new" title="Новое">➕</button>
        <button class="icon-btn" id="btn-settings" title="Настройки">⚙️</button>
      </div>
    </div>
    <div class="sidebar-search">
      <input id="search-input" placeholder="Поиск...">
    </div>
    <div class="sidebar-tabs">
      <button data-stab="chats" class="active">Чаты</button>
      <button data-stab="friends">Друзья</button>
    </div>
    <div id="list-chats" class="sidebar-list"></div>
    <div id="list-friends" class="sidebar-list hidden"></div>
  </aside>
  <main class="chat-main">
    <div class="empty" id="chat-empty"><div>Выберите чат<br>или нажмите ➕</div></div>
    <div class="chat-panel hidden" id="chat-panel">
      <header class="chat-header">
        <button class="back-btn icon-btn" id="btn-back">←</button>
        <div class="avatar sm" id="chat-avatar">?</div>
        <div class="chat-header-info">
          <div class="chat-header-name" id="chat-title">—</div>
          <div class="chat-header-sub" id="chat-subtitle"></div>
        </div>
        <div class="chat-header-actions">
          <button class="icon-btn" id="btn-call-audio" title="Аудиозвонок">📞</button>
          <button class="icon-btn" id="btn-call-video" title="Видеозвонок">📹</button>
          <button class="icon-btn" id="btn-chat-info" title="Инфо">ℹ️</button>
        </div>
      </header>
      <div class="messages" id="messages"></div>
      <div class="typing" id="typing"></div>
      <div class="recording-bar hidden" id="recording-bar">
        <span class="rec-dot"></span><span>Запись <span id="rec-time">0:00</span></span>
        <div class="rec-actions">
          <button type="button" class="icon-btn" id="btn-rec-cancel">✕</button>
          <button type="button" class="icon-btn" id="btn-rec-send">➤</button>
        </div>
      </div>
      <form class="message-form" id="message-form">
        <button type="button" class="icon-btn" id="btn-attach" title="Файл">📎</button>
        <button type="button" class="icon-btn" id="btn-camera" title="Камера">📷</button>
        <input id="message-input" placeholder="Сообщение..." autocomplete="off">
        <button type="button" class="icon-btn" id="btn-mic" title="Голосовое">🎤</button>
        <button type="submit" class="send-btn">➤</button>
        <input type="file" id="file-input" hidden>
      </form>
    </div>
  </main>
</div>

<!-- SETTINGS -->
<div id="modal-settings" class="modal hidden">
  <div class="modal-box">
    <h2>Настройки</h2>
    <div class="avatar-edit">
      <div class="avatar big" id="settings-avatar">?</div>
      <input type="file" id="settings-avatar-input" accept="image/*" hidden>
      <button type="button" class="link-btn" id="settings-avatar-btn">Изменить фото</button>
    </div>
    <label>Имя пользователя</label>
    <input id="settings-username" disabled>
    <label>Отображаемое имя</label>
    <input id="settings-display" placeholder="Как вас зовут">
    <label>О себе</label>
    <textarea id="settings-bio" rows="2" placeholder="Пара слов"></textarea>
    <label>Email</label>
    <input id="settings-email" disabled>
    <div class="modal-actions">
      <button type="button" class="secondary" id="settings-cancel">Отмена</button>
      <button type="button" id="settings-save">Сохранить</button>
    </div>
    <hr>
    <button type="button" class="danger" id="settings-logout">Выйти</button>
  </div>
</div>

<!-- NEW MENU -->
<div id="modal-new" class="modal hidden">
  <div class="modal-box">
    <h2>Новое</h2>
    <div class="new-menu">
      <button data-new="private">👤 Личный чат</button>
      <button data-new="group">👥 Группа</button>
      <button data-new="channel">📢 Канал</button>
    </div>
    <button type="button" class="secondary" id="new-cancel">Отмена</button>
  </div>
</div>

<!-- CREATE GROUP/CHANNEL -->
<div id="modal-create" class="modal hidden">
  <div class="modal-box">
    <h2 id="create-title">Создать группу</h2>
    <label>Название</label>
    <input id="create-name" placeholder="Название">
    <label>Описание</label>
    <textarea id="create-desc" rows="2" placeholder="Необязательно"></textarea>
    <label>Участники</label>
    <div id="create-members" class="member-select"></div>
    <div class="modal-actions">
      <button type="button" class="secondary" id="create-cancel">Отмена</button>
      <button type="button" id="create-submit">Создать</button>
    </div>
  </div>
</div>

<!-- ADD FRIEND -->
<div id="modal-add-friend" class="modal hidden">
  <div class="modal-box">
    <h2>Добавить друга</h2>
    <input id="add-friend-search" placeholder="Поиск по имени">
    <div id="add-friend-results" class="user-results"></div>
    <button type="button" class="secondary" id="add-friend-close">Закрыть</button>
  </div>
</div>

<!-- PROFILE / CHAT INFO -->
<div id="modal-profile" class="modal hidden">
  <div class="modal-box" id="modal-profile-content"></div>
</div>
<div id="modal-chat-info" class="modal hidden">
  <div class="modal-box" id="modal-chat-info-content"></div>
</div>

<!-- INCOMING CALL -->
<div id="modal-call-incoming" class="modal hidden call-modal">
  <div class="call-content">
    <div class="avatar big" id="call-incoming-avatar">?</div>
    <div class="call-name" id="call-incoming-name">—</div>
    <div class="call-type" id="call-incoming-type">Входящий звонок</div>
    <div class="call-actions">
      <button class="call-btn reject" id="call-reject">✕</button>
      <button class="call-btn accept" id="call-accept">✓</button>
    </div>
  </div>
</div>

<!-- ACTIVE CALL -->
<div id="modal-call-active" class="modal hidden call-modal">
  <div class="call-content" id="call-active-content">
    <video id="call-remote-video" autoplay playsinline class="remote-video"></video>
    <video id="call-local-video" autoplay playsinline muted class="local-video hidden"></video>
    <div class="call-info" id="call-info">
      <div class="avatar big" id="call-active-avatar">?</div>
      <div class="call-name" id="call-active-name">—</div>
      <div class="call-status" id="call-active-status">Звоним...</div>
    </div>
    <div class="call-controls">
      <button class="call-btn" id="call-mute" title="Микрофон">🎤</button>
      <button class="call-btn" id="call-video-toggle" title="Видео" style="display:none">📹</button>
      <button class="call-btn reject" id="call-hangup" title="Завершить">✕</button>
    </div>
  </div>
</div>

<!-- CAMERA -->
<div id="modal-camera" class="modal hidden">
  <div class="camera-content">
    <video id="camera-video" autoplay playsinline></video>
    <div class="camera-controls">
      <button type="button" id="camera-close">✕</button>
      <button type="button" id="camera-shoot">◉</button>
      <button type="button" id="camera-flip">🔄</button>
    </div>
  </div>
</div>

<!-- IMAGE PREVIEW -->
<div id="image-preview" class="modal hidden">
  <img id="image-preview-img" style="max-width:95vw;max-height:95vh;border-radius:8px">
</div>

<script src="/socket.io/socket.io.js"></script>
<script src="/app.js"></script>
</body>
</html>`;

// =============================================================================
// КЛИЕНТ — CSS
// =============================================================================
const CSS = `*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0e1621;color:#e4ecf3;height:100vh;height:100dvh;overflow:hidden}
.hidden{display:none!important}
button{cursor:pointer;border:none;font-family:inherit;font-size:15px}
input,textarea{font-family:inherit}
.screen{height:100vh;height:100dvh}
.icon-btn{background:transparent;color:#8ea9c1;font-size:20px;padding:6px 10px;border-radius:50%;line-height:1}
.icon-btn:active{background:#243b53}

/* AUTH */
#screen-auth{display:flex;align-items:center;justify-content:center;padding:16px;background:linear-gradient(135deg,#17212b,#0e1621)}
.auth-box{background:#17212b;padding:28px;border-radius:14px;width:100%;max-width:340px;box-shadow:0 10px 40px rgba(0,0,0,.5)}
.auth-box h1{text-align:center;margin-bottom:22px;font-size:22px}
.tabs{display:flex;gap:4px;margin-bottom:18px;background:#0e1621;padding:4px;border-radius:8px}
.tab{flex:1;padding:10px;background:transparent;color:#8ea9c1;border-radius:6px;font-size:14px}
.tab.active{background:#2b5278;color:#fff}
form{display:flex;flex-direction:column;gap:12px}
#form-login input,#form-register input{padding:12px 14px;background:#0e1621;border:1px solid #243b53;border-radius:8px;color:#e4ecf3;font-size:15px}
#form-login input:focus,#form-register input:focus{outline:none;border-color:#4d9fec}
#form-login button,#form-register button{padding:12px;background:#4d9fec;color:#fff;border-radius:8px;font-size:15px;font-weight:500}
.error{color:#ff6b6b;font-size:13px;min-height:16px}

/* LAYOUT */
#screen-main{display:grid;grid-template-columns:340px 1fr}
.sidebar{background:#17212b;display:flex;flex-direction:column;overflow:hidden;border-right:1px solid #0e1621}
.sidebar-header{padding:10px 12px;display:flex;align-items:center;gap:8px;border-bottom:1px solid #0e1621}
.sidebar-title{flex:1;font-weight:500;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sidebar-actions{display:flex;gap:2px}
.sidebar-search{padding:8px 12px}
.sidebar-search input{width:100%;padding:8px 12px;background:#0e1621;border:1px solid #243b53;border-radius:8px;color:#e4ecf3;font-size:14px}
.sidebar-tabs{display:flex;padding:0 12px;gap:4px;border-bottom:1px solid #0e1621}
.sidebar-tabs button{flex:1;padding:10px;background:transparent;color:#8ea9c1;border-bottom:2px solid transparent;font-size:14px}
.sidebar-tabs button.active{color:#4d9fec;border-bottom-color:#4d9fec}
.sidebar-list{flex:1;overflow-y:auto}
.list-item{display:flex;padding:12px;gap:12px;cursor:pointer;border-bottom:1px solid #0e1621;align-items:center}
.list-item:active{background:#202b36}
.list-item.active{background:#2b5278}
.list-info{flex:1;min-width:0}
.list-name{font-weight:500;font-size:14px;display:flex;gap:6px;align-items:center}
.list-preview{font-size:12px;color:#8ea9c1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.list-time{font-size:11px;color:#8ea9c1}
.hint{padding:16px;color:#8ea9c1;font-size:13px;text-align:center}

/* AVATAR */
.avatar{width:44px;height:44px;border-radius:50%;background:#4d9fec;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:16px;color:#fff;flex-shrink:0;overflow:hidden;background-size:cover;background-position:center}
.avatar.sm{width:36px;height:36px;font-size:14px}
.avatar.big{width:96px;height:96px;font-size:32px}
.avatar.grp{background:#7e57c2}
.avatar.chn{background:#e67e22}
.online-dot{position:absolute;bottom:2px;right:2px;width:12px;height:12px;border-radius:50%;background:#4caf50;border:2px solid #17212b}

/* CHAT MAIN */
.chat-main{display:flex;flex-direction:column;background:#0e1621;min-width:0}
.empty{flex:1;display:flex;align-items:center;justify-content:center;color:#8ea9c1;text-align:center;padding:20px}
.chat-panel{display:flex;flex-direction:column;height:100%}
.chat-header{padding:10px 16px;background:#17212b;border-bottom:1px solid #0e1621;display:flex;align-items:center;gap:10px}
.chat-header-info{flex:1;min-width:0}
.chat-header-name{font-weight:500;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chat-header-sub{font-size:12px;color:#8ea9c1}
.chat-header-actions{display:flex;gap:2px}
.back-btn{display:none;background:transparent;color:#8ea9c1;font-size:22px;padding:0 4px}
.messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:6px}

/* MESSAGES */
.message{max-width:75%;padding:8px 12px;border-radius:12px;background:#182533;align-self:flex-start;word-wrap:break-word;overflow-wrap:break-word;display:flex;flex-direction:column;gap:4px}
.message.mine{background:#2b5278;align-self:flex-end}
.message .sender{font-size:12px;color:#4d9fec;font-weight:500}
.message .text{font-size:14px;line-height:1.4;white-space:pre-wrap}
.message .time{font-size:10px;color:#8ea9c1;text-align:right;margin-top:2px}
.msg-image{max-width:280px;max-height:280px;border-radius:8px;cursor:pointer}
.msg-video{max-width:280px;border-radius:8px}
.msg-audio{max-width:260px}
.msg-file{display:flex;align-items:center;gap:8px;padding:8px;background:#0e1621;border-radius:8px;color:#4d9fec;text-decoration:none;font-size:13px}
.msg-file .fname{word-break:break-all}

/* MESSAGE FORM */
.typing{padding:0 16px 4px;font-size:12px;color:#8ea9c1;font-style:italic;min-height:18px}
.message-form{display:flex;padding:8px 12px;gap:4px;background:#17212b;border-top:1px solid #0e1621;align-items:center}
.message-form input#message-input{flex:1;padding:10px 14px;background:#0e1621;border:1px solid #243b53;border-radius:20px;color:#e4ecf3;font-size:15px;min-width:0}
.message-form input#message-input:focus{outline:none;border-color:#4d9fec}
.send-btn{padding:0 16px;height:38px;background:#4d9fec;color:#fff;border-radius:50%;font-size:16px}
.recording-bar{display:flex;align-items:center;gap:12px;padding:12px 16px;background:#17212b;border-top:1px solid #0e1621;color:#ff6b6b;font-size:14px}
.recording-bar .rec-actions{margin-left:auto;display:flex;gap:4px}
.rec-dot{width:10px;height:10px;border-radius:50%;background:#ff6b6b;animation:blink 1s infinite}
@keyframes blink{50%{opacity:.3}}

/* MODALS */
.modal{position:fixed;inset:0;background:rgba(0,0,0,.8);display:flex;align-items:center;justify-content:center;z-index:100;padding:16px}
.modal-box{background:#17212b;padding:22px;border-radius:14px;width:100%;max-width:400px;max-height:88vh;display:flex;flex-direction:column;gap:12px;overflow-y:auto}
.modal-box h2{font-size:18px}
.modal-box label{font-size:13px;color:#8ea9c1;margin-top:4px}
.modal-box input,.modal-box textarea,.modal-box select{padding:10px 12px;background:#0e1621;border:1px solid #243b53;border-radius:8px;color:#e4ecf3;font-size:14px;width:100%}
.modal-box input:focus,.modal-box textarea:focus{outline:none;border-color:#4d9fec}
.modal-actions{display:flex;gap:8px;margin-top:8px}
.modal-actions button{flex:1;padding:10px;border-radius:8px;font-size:14px}
.secondary{background:#243b53;color:#e4ecf3}
.danger{background:#c0392b;color:#fff}
.link-btn{background:none;color:#4d9fec;font-size:13px;padding:4px}
hr{border:none;border-top:1px solid #243b53;margin:8px 0}
.avatar-edit{display:flex;flex-direction:column;align-items:center;gap:8px}

/* NEW MENU */
.new-menu{display:flex;flex-direction:column;gap:6px}
.new-menu button{padding:14px;text-align:left;background:#0e1621;color:#e4ecf3;border-radius:8px;font-size:15px}
.new-menu button:active{background:#243b53}

/* LISTS */
.member-select,.user-results{max-height:240px;overflow-y:auto;display:flex;flex-direction:column;gap:4px;background:#0e1621;border-radius:8px;padding:4px}
.member-select label,.user-item{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:6px;cursor:pointer;font-size:14px}
.member-select label:active,.user-item:active{background:#243b53}
.member-select input[type=checkbox]{width:auto}

/* CALL */
.call-modal{background:#0b1219}
.call-content{display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;height:100%;position:relative;gap:20px}
.call-name{font-size:22px;font-weight:500}
.call-type,.call-status{color:#8ea9c1;font-size:15px}
.call-actions{display:flex;gap:40px;margin-top:30px}
.call-btn{width:64px;height:64px;border-radius:50%;font-size:24px;background:#2b5278;color:#fff}
.call-btn.reject{background:#c0392b}
.call-btn.accept{background:#2ecc71;animation:pulse 1.5s infinite}
@keyframes pulse{50%{transform:scale(1.08)}}
.call-controls{position:absolute;bottom:40px;display:flex;gap:20px}
.remote-video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0}
.local-video{position:absolute;top:20px;right:20px;width:120px;height:160px;border-radius:10px;object-fit:cover;z-index:2;background:#000}
.call-info,.call-controls{position:relative;z-index:1}
.call-info{background:rgba(14,22,33,.7);padding:20px;border-radius:14px;display:flex;flex-direction:column;align-items:center;gap:8px}

/* CAMERA */
.camera-content{position:relative;width:100%;height:100%;background:#000;display:flex;align-items:center;justify-content:center}
#camera-video{width:100%;max-height:100%;max-width:100%}
.camera-controls{position:absolute;bottom:30px;left:0;right:0;display:flex;justify-content:space-around;align-items:center;padding:0 30px}
.camera-controls button{width:60px;height:60px;border-radius:50%;background:rgba(255,255,255,.2);color:#fff;font-size:24px;backdrop-filter:blur(10px)}
#camera-shoot{width:76px;height:76px;background:#fff;color:#000;font-size:32px}

/* RESPONSIVE */
@media (max-width:760px){
  #screen-main{grid-template-columns:1fr}
  #screen-main .sidebar{display:flex}
  #screen-main .chat-main{display:none}
  #screen-main.chat-open .sidebar{display:none}
  #screen-main.chat-open .chat-main{display:flex}
  .back-btn{display:inline}
  .message{max-width:88%}
  .msg-image,.msg-video{max-width:220px}
}`;

// =============================================================================
// КЛИЕНТ — JS
// =============================================================================
const CLIENT_JS = `(function(){
var S = {
  token: null, me: null, chats: [], friends: [], incoming: [],
  current: null, socket: null, stab: 'chats',
  call: null, typingTimer: null, record: null, camera: null, mediaRec: null
};

function $(id){return document.getElementById(id);}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];});}
function el(tag,cls,html){var e=document.createElement(tag);if(cls)e.className=cls;if(html!=null)e.innerHTML=html;return e;}
function fmtTime(iso){if(!iso)return '';var d=new Date(iso);var n=new Date();var hm=d.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});if(d.toDateString()===n.toDateString())return hm;return d.toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit'});}
function fmtSize(b){if(!b)return '';if(b<1024)return b+' B';if(b<1048576)return (b/1024).toFixed(1)+' KB';return (b/1048576).toFixed(1)+' MB';}
function fmtDur(s){s=Math.floor(s||0);return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');}

function api(path,opts){
  opts=opts||{};
  var headers={'Content-Type':'application/json'};
  if(opts.headers)for(var k in opts.headers)headers[k]=opts.headers[k];
  if(S.token)headers['Authorization']='Bearer '+S.token;
  return fetch(path,{method:opts.method||'GET',headers:headers,body:opts.body})
    .then(function(r){return r.json().catch(function(){return {};}).then(function(d){if(!r.ok)throw new Error(d.error||('HTTP '+r.status));return d;});});
}

function showScreen(name){
  ['screen-auth','screen-main'].forEach(function(id){$(id).classList.add('hidden');});
  $('screen-'+name).classList.remove('hidden');
}

// ============ AUTH ============
document.querySelectorAll('.tab').forEach(function(t){
  t.onclick=function(){
    document.querySelectorAll('.tab').forEach(function(x){x.classList.remove('active');});
    t.classList.add('active');
    var isLogin=t.dataset.tab==='login';
    $('form-login').classList.toggle('hidden',!isLogin);
    $('form-register').classList.toggle('hidden',isLogin);
  };
});

$('form-login').onsubmit=function(e){
  e.preventDefault();
  var fd=new FormData(e.target);
  api('/api/login',{method:'POST',body:JSON.stringify({email:fd.get('email'),password:fd.get('password')})})
    .then(function(d){S.token=d.token;localStorage.setItem('token',S.token);initApp();})
    .catch(function(err){$('login-error').textContent=err.message;});
};
$('form-register').onsubmit=function(e){
  e.preventDefault();
  var fd=new FormData(e.target);
  api('/api/register',{method:'POST',body:JSON.stringify({username:fd.get('username'),email:fd.get('email'),password:fd.get('password')})})
    .then(function(d){S.token=d.token;localStorage.setItem('token',S.token);initApp();})
    .catch(function(err){$('register-error').textContent=err.message;});
};

// ============ INIT ============
function initApp(){
  api('/api/me').then(function(u){
    S.me=u;
    showScreen('main');
    updateMyProfileUI();
    connectSocket();
    loadChats();
    loadFriends();
  }).catch(function(){localStorage.removeItem('token');S.token=null;showScreen('auth');});
}

function updateMyProfileUI(){
  $('my-name').textContent=S.me.display_name||S.me.username;
  setAvatar($('my-avatar'),S.me);
}

function setAvatar(el,user){
  if(user&&user.avatar_url){
    el.style.backgroundImage='url('+user.avatar_url+')';
    el.textContent='';
  }else{
    el.style.backgroundImage='';
    el.textContent=((user&&(user.display_name||user.username))||'?')[0].toUpperCase();
  }
}

// ============ SOCKET ============
function connectSocket(){
  S.socket=io({auth:{token:S.token}});
  S.socket.on('connect',function(){console.log('connected');});
  S.socket.on('message:new',function(m){
    if(S.current&&m.chat_id===S.current.id){
      appendMessage(m);
      S.socket.emit('chat:read',{chatId:m.chat_id});
    }
    loadChats();
  });
  S.socket.on('chat:updated',function(){loadChats();});
  S.socket.on('typing:start',function(d){if(S.current&&d.chatId===S.current.id)$('typing').textContent=d.username+' печатает…';});
  S.socket.on('typing:stop',function(d){if(S.current&&d.chatId===S.current.id)$('typing').textContent='';});
  S.socket.on('presence',function(){loadChats();loadFriends();});
  // calls
  S.socket.on('call:incoming',onIncomingCall);
  S.socket.on('call:accept',onCallAccepted);
  S.socket.on('call:offer',onCallOffer);
  S.socket.on('call:answer',onCallAnswer);
  S.socket.on('call:ice',onCallIce);
  S.socket.on('call:reject',onCallRejected);
  S.socket.on('call:end',onCallEnded);
}

// ============ CHATS LIST ============
function loadChats(){
  api('/api/chats').then(function(list){S.chats=list;renderChats();});
}
function loadFriends(){
  api('/api/friends').then(function(d){S.friends=d.friends||[];S.incoming=d.incoming||[];renderFriends();});
}

function renderChats(){
  var box=$('list-chats');box.innerHTML='';
  var q=($('search-input').value||'').toLowerCase();
  var filtered=S.chats.filter(function(c){
    var t=(c.name||c.peer_name||'').toLowerCase();
    return !q||t.indexOf(q)!==-1;
  });
  if(!filtered.length){
    box.innerHTML='<div class="hint">Пока пусто.<br>Нажмите ➕ чтобы начать чат.</div>';
    return;
  }
  filtered.forEach(function(c){
    var title=c.name||c.peer_name||'Чат';
    var preview=c.last_message||'Нет сообщений';
    var time=fmtTime(c.last_at);
    var row=el('div','list-item'+(S.current&&S.current.id===c.id?' active':''));
    var av=el('div','avatar '+(c.type==='group'?'grp':c.type==='channel'?'chn':''));
    if(c.avatar_url){av.style.backgroundImage='url('+c.avatar_url+')';}
    else{av.textContent=(title[0]||'?').toUpperCase();}
    var info=el('div','list-info');
    var name=el('div','list-name',esc(title)+(c.type==='channel'?' <span style="font-size:11px;color:#8ea9c1">📢</span>':''));
    var prev=el('div','list-preview',esc(preview));
    info.appendChild(name);info.appendChild(prev);
    var right=el('div','');
    right.innerHTML='<div class="list-time">'+esc(time)+'</div>';
    row.appendChild(av);row.appendChild(info);row.appendChild(right);
    row.onclick=function(){openChat(c);};
    box.appendChild(row);
  });
}

function renderFriends(){
  var box=$('list-friends');box.innerHTML='';
  box.appendChild(el('button','link-btn','➕ Добавить друга')).onclick=openAddFriend;
  if(S.incoming.length){
    box.appendChild(el('div','hint','Входящие заявки:'));
    S.incoming.forEach(function(f){
      var row=el('div','list-item');
      var av=el('div','avatar sm');av.textContent=(f.username[0]||'?').toUpperCase();
      var info=el('div','list-info','<div class="list-name">'+esc(f.username)+'</div><div class="list-preview">хочет добавить вас</div>');
      var btn=el('button','link-btn','Принять');
      btn.onclick=function(e){e.stopPropagation();api('/api/friends/accept',{method:'POST',body:JSON.stringify({userId:f.id})}).then(loadFriends);};
      row.appendChild(av);row.appendChild(info);row.appendChild(btn);
      box.appendChild(row);
    });
  }
  if(S.friends.length){
    box.appendChild(el('div','hint','Мои друзья:'));
    S.friends.forEach(function(f){
      var row=el('div','list-item');
      var av=el('div','avatar sm');av.textContent=(f.display_name||f.username)[0].toUpperCase();
      if(f.avatar_url)av.style.backgroundImage='url('+f.avatar_url+')',av.textContent='';
      var info=el('div','list-info','<div class="list-name">'+esc(f.display_name||f.username)+(f.online?' <span style="font-size:11px;color:#4caf50">●</span>':'')+'</div><div class="list-preview">@'+esc(f.username)+'</div>');
      row.appendChild(av);row.appendChild(info);
      row.onclick=function(){api('/api/chats',{method:'POST',body:JSON.stringify({peerId:f.id})}).then(function(c){loadChats();setTimeout(function(){var found=S.chats.find(function(x){return x.id===c.id;});if(found)openChat(found);},200);});};
      box.appendChild(row);
    });
  }
}

// ============ OPEN CHAT ============
function openChat(chat){
  S.current=chat;
  $('screen-main').classList.add('chat-open');
  $('chat-empty').classList.add('hidden');
  $('chat-panel').classList.remove('hidden');
  $('chat-title').textContent=chat.name||chat.peer_name||'Чат';
  var sub='';
  if(chat.type==='private'&&chat.peer_online)sub='в сети';
  if(chat.type==='group')sub='группа';
  if(chat.type==='channel')sub='канал';
  $('chat-subtitle').textContent=sub;
  setAvatar($('chat-avatar'),chat.type==='private'?{username:chat.peer_name,avatar_url:chat.peer_avatar}:chat);
  $('typing').textContent='';
  renderChats();
  S.socket.emit('chat:join',{chatId:chat.id});
  S.socket.emit('chat:read',{chatId:chat.id});
  loadMessages();
  // update message form
  var isReadOnly=chat.type==='channel'&&chat.created_by!==S.me.id;
  $('message-form').classList.toggle('hidden',isReadOnly);
  if(isReadOnly){
    var hint=document.createElement('div');
    hint.className='typing';
    hint.textContent='Только автор канала может писать';
    $('message-form').parentNode.insertBefore(hint,$('message-form'));
  }
}

function loadMessages(){
  api('/api/chats/'+S.current.id+'/messages').then(function(msgs){
    var box=$('messages');box.innerHTML='';
    msgs.forEach(function(m){appendMessage(m,false);});
    box.scrollTop=box.scrollHeight;
  });
}

function appendMessage(m,scroll){
  if(scroll===undefined)scroll=true;
  var box=$('messages');
  var mine=m.sender_id===S.me.id;
  var div=el('div','message'+(mine?' mine':''));
  if(!mine&&S.current.type!=='private'&&m.sender_username){
    div.appendChild(el('div','sender',esc(m.sender_username)));
  }
  if(m.type==='text'){
    div.appendChild(el('div','text',esc(m.content)));
  }else if(m.type==='image'){
    var img=document.createElement('img');
    img.className='msg-image';img.src=m.file_url;
    img.onclick=function(){$('image-preview-img').src=m.file_url;$('image-preview').classList.remove('hidden');};
    div.appendChild(img);
    if(m.content)div.appendChild(el('div','text',esc(m.content)));
  }else if(m.type==='video'){
    var v=document.createElement('video');
    v.className='msg-video';v.src=m.file_url;v.controls=true;
    div.appendChild(v);
    if(m.content)div.appendChild(el('div','text',esc(m.content)));
  }else if(m.type==='voice'){
    var a=document.createElement('audio');
    a.className='msg-audio';a.src=m.file_url;a.controls=true;
    div.appendChild(a);
  }else if(m.type==='file'){
    var link=document.createElement('a');
    link.className='msg-file';link.href=m.file_url;link.download=m.file_name||'file';
    link.innerHTML='📎 <span class="fname">'+esc(m.file_name||'файл')+'</span> <span style="color:#8ea9c1;font-size:11px">'+fmtSize(m.file_size)+'</span>';
    div.appendChild(link);
  }
  div.appendChild(el('div','time',fmtTime(m.created_at)));
  box.appendChild(div);
  if(scroll)box.scrollTop=box.scrollHeight;
}

// ============ SEND ============
$('message-form').onsubmit=function(e){
  e.preventDefault();
  var inp=$('message-input');
  var content=inp.value.trim();
  if(!content||!S.current)return;
  inp.value='';
  S.socket.emit('typing:stop',{chatId:S.current.id});
  api('/api/chats/'+S.current.id+'/messages',{method:'POST',body:JSON.stringify({type:'text',content:content})})
    .catch(function(err){alert('Ошибка: '+err.message);});
};

$('message-input').oninput=function(){
  if(!S.current||!S.socket)return;
  S.socket.emit('typing:start',{chatId:S.current.id});
  clearTimeout(S.typingTimer);
  S.typingTimer=setTimeout(function(){S.socket.emit('typing:stop',{chatId:S.current.id});},2000);
};

// ---------- FILE UPLOAD ----------
function uploadFile(file){
  var fd=new FormData();
  fd.append('file',file);
  return fetch('/api/upload',{method:'POST',headers:{'Authorization':'Bearer '+S.token},body:fd})
    .then(function(r){return r.json().then(function(d){if(!r.ok)throw new Error(d.error||'upload error');return d;});});
}

function sendAttachment(type,uploadResult,extra){
  var body={type:type,file_url:uploadResult.url,file_name:uploadResult.name,file_size:uploadResult.size};
  if(extra)for(var k in extra)body[k]=extra[k];
  return api('/api/chats/'+S.current.id+'/messages',{method:'POST',body:JSON.stringify(body)});
}

$('btn-attach').onclick=function(){
  if(!S.current)return;
  var inp=$('file-input');
  inp.accept='';
  inp.value='';
  inp.onchange=function(){
    var f=inp.files[0];
    if(!f)return;
    uploadFile(f).then(function(r){
      var type='file';
      if(f.type.indexOf('image/')===0)type='image';
      else if(f.type.indexOf('video/')===0)type='video';
      else if(f.type.indexOf('audio/')===0)type='voice';
      return sendAttachment(type,r);
    }).catch(function(e){alert('Ошибка загрузки: '+e.message);});
  };
  inp.click();
};

// ============ VOICE RECORDING ============
$('btn-mic').onclick=startVoiceRecording;

function startVoiceRecording(){
  if(!S.current)return;
  if(S.mediaRec){stopAndSendVoice();return;}
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
    alert('Микрофон недоступен (нужен HTTPS)');return;
  }
  navigator.mediaDevices.getUserMedia({audio:true}).then(function(stream){
    var mime='audio/webm';
    if(!MediaRecorder.isTypeSupported(mime))mime='audio/mp4';
    var rec=new MediaRecorder(stream,{mimeType:mime});
    var chunks=[];
    var startAt=Date.now();
    rec.ondataavailable=function(e){if(e.data.size>0)chunks.push(e.data);};
    rec.onstop=function(){
      stream.getTracks().forEach(function(t){t.stop();});
    };
    rec.start();
    S.mediaRec=rec;
    S.record={chunks:chunks,startAt:startAt,stream:stream,mime:mime};
    $('recording-bar').classList.remove('hidden');
    $('btn-mic').textContent='⏹';
    var tick=setInterval(function(){
      if(!S.record){clearInterval(tick);return;}
      $('rec-time').textContent=fmtDur((Date.now()-startAt)/1000);
    },500);
    S.record.tick=tick;
  }).catch(function(e){alert('Нет доступа к микрофону: '+e.message);});
}

function stopAndSendVoice(){
  if(!S.mediaRec)return;
  var rec=S.mediaRec;
  var data=S.record;
  rec.stop();
  clearInterval(data.tick);
  $('recording-bar').classList.add('hidden');
  $('btn-mic').textContent='🎤';
  S.mediaRec=null;S.record=null;
  if(Date.now()-data.startAt<800)return;
  var blob=new Blob(data.chunks,{type:data.mime});
  var ext=data.mime.indexOf('mp4')>=0?'m4a':'webm';
  var file=new File([blob],'voice.'+ext,{type:data.mime});
  uploadFile(file).then(function(r){
    return sendAttachment('voice',r,{duration:Math.floor((Date.now()-data.startAt)/1000)});
  }).catch(function(e){alert('Ошибка: '+e.message);});
}

$('btn-rec-cancel').onclick=function(){
  if(S.mediaRec){S.mediaRec.stop();}
  if(S.record){clearInterval(S.record.tick);S.record.stream.getTracks().forEach(function(t){t.stop();});}
  S.mediaRec=null;S.record=null;
  $('recording-bar').classList.add('hidden');
  $('btn-mic').textContent='🎤';
};
$('btn-rec-send').onclick=stopAndSendVoice;

// ============ CAMERA ============
$('btn-camera').onclick=openCamera;

function openCamera(){
  if(!S.current)return;
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
    alert('Камера недоступна (нужен HTTPS)');return;
  }
  var facing='environment';
  var open=function(){
    navigator.mediaDevices.getUserMedia({video:{facingMode:facing}}).then(function(stream){
      S.camera={stream:stream,facing:facing};
      $('camera-video').srcObject=stream;
      $('modal-camera').classList.remove('hidden');
    }).catch(function(e){
      alert('Нет доступа к камере: '+e.message);
      if(facing==='environment'){facing='user';open();}
    });
  };
  open();
}

$('camera-close').onclick=function(){
  if(S.camera){S.camera.stream.getTracks().forEach(function(t){t.stop();});S.camera=null;}
  $('modal-camera').classList.add('hidden');
};

$('camera-flip').onclick=function(){
  if(S.camera){S.camera.stream.getTracks().forEach(function(t){t.stop();});}
  var facing=(S.camera&&S.camera.facing==='environment')?'user':'environment';
  navigator.mediaDevices.getUserMedia({video:{facingMode:facing}}).then(function(stream){
    S.camera={stream:stream,facing:facing};
    $('camera-video').srcObject=stream;
  }).catch(function(e){alert(e.message);});
};

$('camera-shoot').onclick=function(){
  var v=$('camera-video');
  var c=document.createElement('canvas');
  c.width=v.videoWidth;c.height=v.videoHeight;
  c.getContext('2d').drawImage(v,0,0);
  c.toBlob(function(blob){
    var file=new File([blob],'photo.jpg',{type:'image/jpeg'});
    uploadFile(file).then(function(r){return sendAttachment('image',r);})
      .catch(function(e){alert('Ошибка: '+e.message);});
    $('camera-close').onclick();
  },'image/jpeg',0.85);
};

// ============ SETTINGS ============
$('btn-settings').onclick=openSettings;
$('btn-profile').onclick=openSettings;

function openSettings(){
  $('settings-username').value=S.me.username;
  $('settings-email').value=S.me.email;
  $('settings-display').value=S.me.display_name||'';
  $('settings-bio').value=S.me.bio||'';
  setAvatar($('settings-avatar'),S.me);
  $('modal-settings').classList.remove('hidden');
}
$('settings-cancel').onclick=function(){$('modal-settings').classList.add('hidden');};
$('settings-logout').onclick=function(){localStorage.removeItem('token');if(S.socket)S.socket.disconnect();location.reload();};

$('settings-avatar-btn').onclick=function(){$('settings-avatar-input').click();};
$('settings-avatar-input').onchange=function(e){
  var f=e.target.files[0];if(!f)return;
  uploadFile(f).then(function(r){
    return api('/api/me',{method:'PATCH',body:JSON.stringify({avatar_url:r.url})});
  }).then(function(u){
    S.me=u;updateMyProfileUI();setAvatar($('settings-avatar'),S.me);
  }).catch(function(e){alert(e.message);});
};

$('settings-save').onclick=function(){
  var body={
    display_name:$('settings-display').value.trim()||null,
    bio:$('settings-bio').value.trim()||null
  };
  api('/api/me',{method:'PATCH',body:JSON.stringify(body)}).then(function(u){
    S.me=u;updateMyProfileUI();$('modal-settings').classList.add('hidden');
  }).catch(function(e){alert(e.message);});
};

// ============ NEW CHAT / GROUP / CHANNEL ============
$('btn-new').onclick=function(){$('modal-new').classList.remove('hidden');};
$('new-cancel').onclick=function(){$('modal-new').classList.add('hidden');};
document.querySelectorAll('.new-menu button').forEach(function(b){
  b.onclick=function(){
    $('modal-new').classList.add('hidden');
    var kind=b.dataset.new;
    if(kind==='private'){openNewPrivate();}
    else{openCreateGroup(kind);}
  };
});

function openNewPrivate(){
  openAddFriend();
}

function openCreateGroup(kind){
  $('create-title').textContent=kind==='group'?'Новая группа':'Новый канал';
  $('create-name').value='';
  $('create-desc').value='';
  $('create-members').innerHTML='';
  api('/api/friends').then(function(d){
    (d.friends||[]).forEach(function(f){
      var label=el('label');
      var cb=document.createElement('input');cb.type='checkbox';cb.value=f.id;
      label.appendChild(cb);
      label.appendChild(document.createTextNode(' '+(f.display_name||f.username)));
      $('create-members').appendChild(label);
    });
    if(!(d.friends||[]).length)$('create-members').innerHTML='<div class="hint">Добавьте друзей сначала</div>';
  });
  $('modal-create').classList.remove('hidden');
  $('create-submit').onclick=function(){
    var name=$('create-name').value.trim();
    if(!name)return alert('Введите название');
    var memberIds=[];
    document.querySelectorAll('#create-members input:checked').forEach(function(cb){memberIds.push(cb.value);});
    api('/api/chats',{method:'POST',body:JSON.stringify({type:kind,name:name,description:$('create-desc').value.trim(),memberIds:memberIds})})
      .then(function(c){
        $('modal-create').classList.add('hidden');
        loadChats();
        setTimeout(function(){var found=S.chats.find(function(x){return x.id===c.id;});if(found)openChat(found);},200);
      }).catch(function(e){alert(e.message);});
  };
}
$('create-cancel').onclick=function(){$('modal-create').classList.add('hidden');};

// ============ ADD FRIEND ============
function openAddFriend(){
  $('modal-add-friend').classList.remove('hidden');
  $('add-friend-search').value='';
  $('add-friend-results').innerHTML='';
  searchUsers('');
}
$('add-friend-close').onclick=function(){$('modal-add-friend').classList.add('hidden');};
$('add-friend-search').oninput=function(){searchUsers(this.value);};

function searchUsers(q){
  api('/api/users/search?q='+encodeURIComponent(q)).then(function(users){
    var box=$('add-friend-results');box.innerHTML='';
    if(!users.length){box.innerHTML='<div class="hint">Никого не найдено</div>';return;}
    users.forEach(function(u){
      var row=el('div','user-item');
      var av=el('div','avatar sm');av.textContent=(u.display_name||u.username)[0].toUpperCase();
      if(u.avatar_url){av.style.backgroundImage='url('+u.avatar_url+')';av.textContent='';}
      var info=el('div','list-info');
      info.innerHTML='<div class="list-name">'+esc(u.display_name||u.username)+'</div><div class="list-preview">@'+esc(u.username)+'</div>';
      row.appendChild(av);row.appendChild(info);
      if(u.friend_status==='accepted'){
        row.appendChild(el('span','list-time','друг'));
      }else if(u.friend_status==='pending_out'){
        row.appendChild(el('span','list-time','запрос отправлен'));
      }else if(u.friend_status==='pending_in'){
        var btn=el('button','link-btn','Принять');
        btn.onclick=function(e){e.stopPropagation();api('/api/friends/accept',{method:'POST',body:JSON.stringify({userId:u.id})}).then(function(){searchUsers(q);loadFriends();});};
        row.appendChild(btn);
      }else{
        var btn2=el('button','link-btn','+ Добавить');
        btn2.onclick=function(e){e.stopPropagation();api('/api/friends/request',{method:'POST',body:JSON.stringify({userId:u.id})}).then(function(){searchUsers(q);});};
        row.appendChild(btn2);
      }
      row.onclick=function(){
        api('/api/chats',{method:'POST',body:JSON.stringify({peerId:u.id})}).then(function(c){
          $('modal-add-friend').classList.add('hidden');
          loadChats();
          setTimeout(function(){var found=S.chats.find(function(x){return x.id===c.id;});if(found)openChat(found);},200);
        });
      };
      box.appendChild(row);
    });
  });
}

// ============ CHAT INFO ============
$('btn-chat-info').onclick=function(){
  if(!S.current)return;
  var c=S.current;
  var box=$('modal-chat-info-content');box.innerHTML='';
  box.appendChild(el('h2',null,esc(c.name||c.peer_name||'Чат')));
  if(c.description)box.appendChild(el('div','list-preview',esc(c.description)));
  box.appendChild(el('div','list-preview','Тип: '+c.type));
  if(c.type==='private'&&c.peer_id){
    var btn=el('button','secondary','👤 Профиль');
    btn.onclick=function(){api('/api/users/'+c.peer_id).then(openProfileModal);};
    box.appendChild(btn);
  }
  if(c.type!=='private'){
    var mems=el('div');
    mems.innerHTML='<div class="hint">Участники:</div>';
    api('/api/chats/'+c.id+'/members').then(function(ms){
      ms.forEach(function(m){
        mems.appendChild(el('div','user-item',esc(m.display_name||m.username)+(m.online?' <span style="color:#4caf50">●</span>':'')));
      });
    });
    box.appendChild(mems);
  }
  var close=el('button','secondary','Закрыть');
  close.onclick=function(){$('modal-chat-info').classList.add('hidden');};
  box.appendChild(close);
  $('modal-chat-info').classList.remove('hidden');
};

function openProfileModal(u){
  var box=$('modal-profile-content');box.innerHTML='';
  var av=el('div','avatar big');
  if(u.avatar_url){av.style.backgroundImage='url('+u.avatar_url+')';}
  else{av.textContent=(u.display_name||u.username)[0].toUpperCase();}
  box.appendChild(av);
  box.appendChild(el('h2',null,esc(u.display_name||u.username)));
  box.appendChild(el('div','list-preview','@'+esc(u.username)));
  if(u.bio)box.appendChild(el('div','list-preview',esc(u.bio)));
  var close=el('button','secondary','Закрыть');
  close.onclick=function(){$('modal-profile').classList.add('hidden');};
  box.appendChild(close);
  $('modal-profile').classList.remove('hidden');
}

// ============ NAV / MISC ============
$('btn-back').onclick=function(){
  $('screen-main').classList.remove('chat-open');
  S.current=null;
  $('chat-panel').classList.add('hidden');
  $('chat-empty').classList.remove('hidden');
  renderChats();
};

document.querySelectorAll('.sidebar-tabs button').forEach(function(t){
  t.onclick=function(){
    document.querySelectorAll('.sidebar-tabs button').forEach(function(x){x.classList.remove('active');});
    t.classList.add('active');
    S.stab=t.dataset.stab;
    $('list-chats').classList.toggle('hidden',S.stab!=='chats');
    $('list-friends').classList.toggle('hidden',S.stab!=='friends');
  };
});

$('search-input').oninput=renderChats;
$('image-preview').onclick=function(){$('image-preview').classList.add('hidden');};

// ============ CALLS ============
var ICE={iceServers:[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}]};

function startCall(type){
  if(!S.current||S.current.type!=='private'||!S.current.peer_id){
    alert('Звонки только в личных чатах');return;
  }
  if(S.call){alert('Уже в звонке');return;}
  S.call={peerId:S.current.peer_id,peerName:S.current.peer_name||'Собеседник',
    type:type,isCaller:true,status:'ringing',pc:null,localStream:null};
  showCallActiveUI();
  S.socket.emit('call:invite',{toUserId:S.current.peer_id,type:type});
  $('call-active-status').textContent='Звоним...';
}
$('btn-call-audio').onclick=function(){startCall('audio');};
$('btn-call-video').onclick=function(){startCall('video');};

function onIncomingCall(d){
  if(S.call){S.socket.emit('call:reject',{toUserId:d.fromUserId});return;}
  S.call={peerId:d.fromUserId,peerName:d.fromUsername,type:d.type,isCaller:false,status:'incoming',pc:null,localStream:null};
  $('call-incoming-name').textContent=d.fromUsername;
  $('call-incoming-type').textContent=d.type==='video'?'Видеозвонок':'Аудиозвонок';
  $('call-incoming-avatar').textContent=(d.fromUsername[0]||'?').toUpperCase();
  $('modal-call-incoming').classList.remove('hidden');
}

$('call-reject').onclick=function(){
  if(S.call){S.socket.emit('call:reject',{toUserId:S.call.peerId});}
  cleanupCall();
};

$('call-accept').onclick=function(){
  $('modal-call-incoming').classList.add('hidden');
  S.socket.emit('call:accept',{toUserId:S.call.peerId});
  S.call.status='connecting';
  showCallActiveUI();
  getMedia().then(function(stream){
    S.call.localStream=stream;
    if(S.call.type==='video'){showLocalVideo(stream);}
  }).catch(function(e){
    alert('Нет доступа к камере/микрофону: '+e.message);
    hangupCall();
  });
};

function getMedia(){
  return navigator.mediaDevices.getUserMedia({
    audio:true,
    video:S.call&&S.call.type==='video'?{facingMode:'user'}:false
  });
}

function onCallAccepted(d){
  if(!S.call||!S.call.isCaller)return;
  $('call-active-status').textContent='Соединение...';
  getMedia().then(function(stream){
    S.call.localStream=stream;
    if(S.call.type==='video'){showLocalVideo(stream);}
    var pc=new RTCPeerConnection(ICE);
    S.call.pc=pc;
    stream.getTracks().forEach(function(t){pc.addTrack(t,stream);});
    pc.ontrack=function(e){showRemoteStream(e.streams[0]);};
    pc.onicecandidate=function(e){if(e.candidate)S.socket.emit('call:ice',{toUserId:S.call.peerId,candidate:e.candidate});};
    pc.onconnectionstatechange=function(){
      if(pc.connectionState==='connected'){$('call-active-status').textContent='Соединено';}
      if(pc.connectionState==='disconnected'||pc.connectionState==='failed'){onCallEnded();}
    };
    pc.createOffer().then(function(offer){
      return pc.setLocalDescription(offer).then(function(){
        S.socket.emit('call:offer',{toUserId:S.call.peerId,offer:offer});
      });
    });
  }).catch(function(e){alert('Нет доступа: '+e.message);hangupCall();});
}

function onCallOffer(d){
  if(!S.call||S.call.isCaller)return;
  var pc=new RTCPeerConnection(ICE);
  S.call.pc=pc;
  if(S.call.localStream){S.call.localStream.getTracks().forEach(function(t){pc.addTrack(t,S.call.localStream);});}
  pc.ontrack=function(e){showRemoteStream(e.streams[0]);};
  pc.onicecandidate=function(e){if(e.candidate)S.socket.emit('call:ice',{toUserId:S.call.peerId,candidate:e.candidate});};
  pc.onconnectionstatechange=function(){
    if(pc.connectionState==='connected'){$('call-active-status').textContent='Соединено';}
    if(pc.connectionState==='disconnected'||pc.connectionState==='failed'){onCallEnded();}
  };
  pc.setRemoteDescription(new RTCSessionDescription(d.offer)).then(function(){
    return pc.createAnswer();
  }).then(function(answer){
    return pc.setLocalDescription(answer).then(function(){
      S.socket.emit('call:answer',{toUserId:S.call.peerId,answer:answer});
    });
  }).catch(function(e){console.error(e);});
}

function onCallAnswer(d){
  if(!S.call||!S.call.pc)return;
  S.call.pc.setRemoteDescription(new RTCSessionDescription(d.answer)).catch(function(e){console.error(e);});
}

function onCallIce(d){
  if(!S.call||!S.call.pc)return;
  S.call.pc.addIceCandidate(new RTCIceCandidate(d.candidate)).catch(function(){});
}

function onCallRejected(){
  alert('Звонок отклонён');
  cleanupCall();
}

function onCallEnded(){
  cleanupCall();
}

function showCallActiveUI(){
  $('modal-call-active').classList.remove('hidden');
  $('call-active-name').textContent=S.call.peerName;
  $('call-active-avatar').textContent=(S.call.peerName[0]||'?').toUpperCase();
  $('call-active-status').textContent=S.call.status==='ringing'?'Звоним...':'Соединение...';
  $('call-video-toggle').style.display=S.call.type==='video'?'inline-block':'none';
}

function showLocalVideo(stream){
  var v=$('call-local-video');
  v.srcObject=stream;v.classList.remove('hidden');
  v.muted=true;
}
function showRemoteStream(stream){
  var v=$('call-remote-video');
  v.srcObject=stream;
  if(S.call.type==='video'){
    v.classList.remove('hidden');
    $('call-info').style.display='none';
  }else{
    v.classList.add('hidden');
    $('call-info').style.display='flex';
    $('call-active-status').textContent='Соединено';
  }
}

$('call-hangup').onclick=hangupCall;
$('call-mute').onclick=function(){
  if(!S.call||!S.call.localStream)return;
  var audioTracks=S.call.localStream.getAudioTracks();
  var muted=!audioTracks[0].enabled;
  audioTracks.forEach(function(t){t.enabled=muted;});
  this.textContent=muted?'🔇':'🎤';
};

function hangupCall(){
  if(S.call){
    S.socket.emit('call:end',{toUserId:S.call.peerId});
  }
  cleanupCall();
}

function cleanupCall(){
  if(S.call&&S.call.pc){try{S.call.pc.close();}catch(e){}}
  if(S.call&&S.call.localStream){S.call.localStream.getTracks().forEach(function(t){t.stop();});}
  S.call=null;
  $('modal-call-active').classList.add('hidden');
  $('modal-call-incoming').classList.add('hidden');
  $('call-local-video').classList.add('hidden');
  $('call-remote-video').classList.add('hidden');
  $('call-remote-video').srcObject=null;
  $('call-local-video').srcObject=null;
  $('call-mute').textContent='🎤';
}

// ============ BOOT ============
S.token=localStorage.getItem('token');
if(S.token){initApp();}else{showScreen('auth');}

})();`;

// ---------- Отдаём клиент ----------
app.get('/', (req, res) => res.type('html').send(HTML));
app.get('/style.css', (req, res) => res.type('css').send(CSS));
app.get('/app.js', (req, res) => res.type('js').send(CLIENT_JS));

// =============================================================================
// ХЕЛПЕРЫ
// =============================================================================
const signToken = (u) => jwt.sign({ id: u.id, username: u.username }, JWT_SECRET, { expiresIn: '30d' });

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!t) return res.status(401).json({ error: 'Нет токена' });
  try { req.user = jwt.verify(t, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Токен недействителен' }); }
}

const publicUser = (u) => u ? ({
  id: u.id, username: u.username, email: u.email,
  display_name: u.display_name, avatar_url: u.avatar_url, bio: u.bio,
  online: onlineUsers.has(u.id)
}) : null;

const friendshipStatus = (a, b) => {
  const f = db.friendships.find(x =>
    (x.from_id === a && x.to_id === b) || (x.from_id === b && x.to_id === a));
  if (!f) return null;
  if (f.status === 'accepted') return 'accepted';
  return f.from_id === a ? 'pending_out' : 'pending_in';
};

function chatSummary(chat, forUserId) {
  const members = db.chat_members.filter(m => m.chat_id === chat.id);
  const peerM = members.find(m => m.user_id !== forUserId);
  const peer = peerM ? db.users.find(u => u.id === peerM.user_id) : null;
  const msgs = db.messages.filter(m => m.chat_id === chat.id);
  const lastMsg = msgs[msgs.length - 1];
  let preview = null;
  if (lastMsg) {
    if (lastMsg.type === 'text') preview = lastMsg.content;
    else if (lastMsg.type === 'image') preview = '📷 Фото';
    else if (lastMsg.type === 'video') preview = '🎬 Видео';
    else if (lastMsg.type === 'voice') preview = '🎤 Голосовое';
    else if (lastMsg.type === 'file') preview = '📎 ' + (lastMsg.file_name || 'Файл');
  }
  return {
    id: chat.id, type: chat.type, name: chat.name,
    description: chat.description, avatar_url: chat.avatar_url,
    created_by: chat.created_by,
    peer_id: peer ? peer.id : null,
    peer_name: peer ? (peer.display_name || peer.username) : null,
    peer_avatar: peer ? peer.avatar_url : null,
    peer_online: peer ? onlineUsers.has(peer.id) : false,
    last_message: preview, last_at: lastMsg ? lastMsg.created_at : null
  };
}

// =============================================================================
// API
// =============================================================================
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: 'Заполните все поля' });
    if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) return res.status(400).json({ error: 'Имя: 3–32 символа a-z0-9_' });
    if (password.length < 6) return res.status(400).json({ error: 'Пароль 6+ символов' });
    const uname = username.trim(), mail = email.trim().toLowerCase();
    if (db.users.some(u => u.username.toLowerCase() === uname.toLowerCase()))
      return res.status(409).json({ error: 'Имя занято' });
    if (db.users.some(u => u.email === mail))
      return res.status(409).json({ error: 'Email уже используется' });
    const hash = await bcrypt.hash(password, 10);
    const u = { id: uid(), username: uname, email: mail, password_hash: hash,
      display_name: uname, avatar_url: null, bio: null, created_at: now() };
    db.users.push(u); save();
    res.json({ token: signToken(u), user: publicUser(u) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const u = db.users.find(x => x.email === (email || '').trim().toLowerCase());
  if (!u) return res.status(401).json({ error: 'Неверный email или пароль' });
  const ok = await bcrypt.compare(password || '', u.password_hash);
  if (!ok) return res.status(401).json({ error: 'Неверный email или пароль' });
  res.json({ token: signToken(u), user: publicUser(u) });
});

app.get('/api/me', auth, (req, res) => {
  const u = db.users.find(x => x.id === req.user.id);
  if (!u) return res.status(404).json({ error: 'Не найден' });
  res.json(publicUser(u));
});

app.patch('/api/me', auth, (req, res) => {
  const u = db.users.find(x => x.id === req.user.id);
  if (!u) return res.status(404).json({ error: 'Не найден' });
  const { display_name, bio, avatar_url } = req.body || {};
  if (display_name !== undefined) u.display_name = String(display_name || '').slice(0, 64) || null;
  if (bio !== undefined) u.bio = String(bio || '').slice(0, 256) || null;
  if (avatar_url !== undefined) u.avatar_url = avatar_url;
  save();
  res.json(publicUser(u));
});

app.get('/api/users/:id', auth, (req, res) => {
  const u = db.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'Не найден' });
  res.json(publicUser(u));
});

app.get('/api/users/search', auth, (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  const out = db.users.filter(u => u.id !== req.user.id)
    .filter(u => !q || u.username.toLowerCase().includes(q)
      || (u.display_name || '').toLowerCase().includes(q))
    .slice(0, 30)
    .map(u => ({ ...publicUser(u), friend_status: friendshipStatus(req.user.id, u.id) }));
  res.json(out);
});

// ---------- Upload ----------
app.post('/api/upload', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  res.json({
    url: '/uploads/' + req.file.filename,
    name: req.file.originalname,
    size: req.file.size,
    type: req.file.mimetype
  });
});

// ---------- Friends ----------
app.get('/api/friends', auth, (req, res) => {
  const me = req.user.id;
  const friends = [], incoming = [];
  db.friendships.forEach(f => {
    if (f.status === 'accepted') {
      const other = f.from_id === me ? f.to_id : f.to_id === me ? f.from_id : null;
      if (!other) return;
      const u = db.users.find(x => x.id === other);
      if (u) friends.push(publicUser(u));
    } else if (f.status === 'pending' && f.to_id === me) {
      const u = db.users.find(x => x.id === f.from_id);
      if (u) incoming.push(publicUser(u));
    }
  });
  res.json({ friends, incoming });
});

app.post('/api/friends/request', auth, (req, res) => {
  const { userId } = req.body;
  if (!userId || userId === req.user.id) return res.status(400).json({ error: 'Неверно' });
  if (!db.users.some(u => u.id === userId)) return res.status(404).json({ error: 'Пользователь не найден' });
  if (friendshipStatus(req.user.id, userId)) return res.status(409).json({ error: 'Уже есть связь' });
  db.friendships.push({ id: uid(), from_id: req.user.id, to_id: userId, status: 'pending', created_at: now() });
  save();
  io.to('user:' + userId).emit('friend:request', { from: req.user.id });
  res.json({ ok: true });
});

app.post('/api/friends/accept', auth, (req, res) => {
  const { userId } = req.body;
  const f = db.friendships.find(x => x.from_id === userId && x.to_id === req.user.id && x.status === 'pending');
  if (!f) return res.status(404).json({ error: 'Заявка не найдена' });
  f.status = 'accepted';
  save();
  // Автоматически создать приватный чат
  const myIds = db.chat_members.filter(m => m.user_id === req.user.id).map(m => m.chat_id);
  const exists = myIds.some(cid => {
    const members = db.chat_members.filter(m => m.chat_id === cid);
    return members.length === 2 && members.some(m => m.user_id === userId);
  });
  if (!exists) {
    const chat = { id: uid(), type: 'private', name: null, created_by: req.user.id, created_at: now() };
    db.chats.push(chat);
    db.chat_members.push({ chat_id: chat.id, user_id: req.user.id, role: 'member', joined_at: now() });
    db.chat_members.push({ chat_id: chat.id, user_id: userId, role: 'member', joined_at: now() });
    save();
  }
  io.to('user:' + userId).emit('friend:accepted', { by: req.user.id });
  res.json({ ok: true });
});

// ---------- Chats ----------
app.get('/api/chats', auth, (req, res) => {
  const myIds = db.chat_members.filter(m => m.user_id === req.user.id).map(m => m.chat_id);
  const result = myIds.map(cid => db.chats.find(c => c.id === cid)).filter(Boolean)
    .map(c => chatSummary(c, req.user.id))
    .sort((a, b) => (b.last_at || '').localeCompare(a.last_at || ''));
  res.json(result);
});

app.post('/api/chats', auth, (req, res) => {
  const { type, name, description, memberIds, peerId } = req.body;

  if (peerId) {
    if (peerId === req.user.id) return res.status(400).json({ error: 'Нельзя с собой' });
    if (!db.users.some(u => u.id === peerId)) return res.status(404).json({ error: 'Пользователь не найден' });
    const myIds = db.chat_members.filter(m => m.user_id === req.user.id).map(m => m.chat_id);
    for (const cid of myIds) {
      const members = db.chat_members.filter(m => m.chat_id === cid);
      if (members.length === 2 && members.some(m => m.user_id === peerId)) {
        const chat = db.chats.find(c => c.id === cid && c.type === 'private');
        if (chat) return res.json({ id: chat.id });
      }
    }
    const chat = { id: uid(), type: 'private', name: null, created_by: req.user.id, created_at: now() };
    db.chats.push(chat);
    db.chat_members.push({ chat_id: chat.id, user_id: req.user.id, role: 'member', joined_at: now() });
    db.chat_members.push({ chat_id: chat.id, user_id: peerId, role: 'member', joined_at: now() });
    save();
    // Присоединить участников к комнате
    io.to('user:' + req.user.id).emit('chat:updated', {});
    io.to('user:' + peerId).emit('chat:updated', {});
    return res.json({ id: chat.id });
  }

  if (type !== 'group' && type !== 'channel')
    return res.status(400).json({ error: 'Неверный тип' });
  if (!name) return res.status(400).json({ error: 'Нужно название' });

  const chat = { id: uid(), type, name: String(name).slice(0, 128),
    description: description ? String(description).slice(0, 512) : null,
    avatar_url: null, created_by: req.user.id, created_at: now() };
  db.chats.push(chat);
  db.chat_members.push({ chat_id: chat.id, user_id: req.user.id, role: 'owner', joined_at: now() });
  (memberIds || []).forEach(mid => {
    if (mid !== req.user.id && db.users.some(u => u.id === mid))
      db.chat_members.push({ chat_id: chat.id, user_id: mid, role: 'member', joined_at: now() });
  });
  save();
  (memberIds || []).forEach(mid => io.to('user:' + mid).emit('chat:updated', {}));
  res.json({ id: chat.id });
});

app.get('/api/chats/:id/members', auth, (req, res) => {
  const ms = db.chat_members.filter(m => m.chat_id === req.params.id)
    .map(m => db.users.find(u => u.id === m.user_id))
    .filter(Boolean)
    .map(publicUser);
  res.json(ms);
});

app.get('/api/chats/:id/messages', auth, (req, res) => {
  const isMember = db.chat_members.some(m => m.chat_id === req.params.id && m.user_id === req.user.id);
  if (!isMember) return res.status(403).json({ error: 'Не участник' });
  const msgs = db.messages.filter(m => m.chat_id === req.params.id).slice(-300)
    .map(m => {
      const s = db.users.find(u => u.id === m.sender_id);
      return { ...m, sender_username: s ? (s.display_name || s.username) : null };
    });
  res.json(msgs);
});

app.post('/api/chats/:id/messages', auth, (req, res) => {
  const chatId = req.params.id;
  const isMember = db.chat_members.some(m => m.chat_id === chatId && m.user_id === req.user.id);
  if (!isMember) return res.status(403).json({ error: 'Не участник' });
  const chat = db.chats.find(c => c.id === chatId);
  if (chat && chat.type === 'channel' && chat.created_by !== req.user.id)
    return res.status(403).json({ error: 'В канале пишет только автор' });

  const { type = 'text', content, file_url, file_name, file_size, duration } = req.body;
  if (type === 'text' && (!content || !content.trim()))
    return res.status(400).json({ error: 'Пусто' });
  if (type !== 'text' && !file_url)
    return res.status(400).json({ error: 'Нет файла' });

  const msg = {
    id: uid(), chat_id: chatId, sender_id: req.user.id,
    sender_username: req.user.username,
    type, content: content || null, file_url: file_url || null,
    file_name: file_name || null, file_size: file_size || null,
    duration: duration || null, created_at: now()
  };
  db.messages.push(msg); save();

  const payload = { ...msg };
  io.to('chat:' + chatId).emit('message:new', payload);
  const members = db.chat_members.filter(m => m.chat_id === chatId);
  for (const m of members) io.to('user:' + m.user_id).emit('chat:updated', { chatId });
  res.json(payload);
});

// =============================================================================
// SOCKET.IO
// =============================================================================
io.use((socket, next) => {
  const t = socket.handshake.auth && socket.handshake.auth.token;
  if (!t) return next(new Error('No token'));
  try { socket.user = jwt.verify(t, JWT_SECRET); next(); }
  catch { next(new Error('Bad token')); }
});

io.on('connection', (socket) => {
  const uid_ = socket.user.id;
  socket.join('user:' + uid_);
  const myChats = db.chat_members.filter(m => m.user_id === uid_).map(m => m.chat_id);
  myChats.forEach(cid => socket.join('chat:' + cid));

  // presence
  const wasOffline = !onlineUsers.has(uid_);
  onlineUsers.set(uid_, (onlineUsers.get(uid_) || 0) + 1);
  if (wasOffline) io.emit('presence', { userId: uid_, online: true });

  console.log('[socket] ' + socket.user.username + ' connected');

  socket.on('chat:join', ({ chatId }) => { if (chatId) socket.join('chat:' + chatId); });
  socket.on('typing:start', ({ chatId }) => {
    socket.to('chat:' + chatId).emit('typing:start', { chatId, username: socket.user.username });
  });
  socket.on('typing:stop', ({ chatId }) => {
    socket.to('chat:' + chatId).emit('typing:stop', { chatId });
  });

  // === CALLS ===
  socket.on('call:invite', ({ toUserId, type }) => {
    io.to('user:' + toUserId).emit('call:incoming', {
      fromUserId: uid_, fromUsername: socket.user.username, type
    });
  });
  socket.on('call:accept', ({ toUserId }) => {
    io.to('user:' + toUserId).emit('call:accept', { fromUserId: uid_ });
  });
  socket.on('call:offer', ({ toUserId, offer }) => {
    io.to('user:' + toUserId).emit('call:offer', { fromUserId: uid_, offer });
  });
  socket.on('call:answer', ({ toUserId, answer }) => {
    io.to('user:' + toUserId).emit('call:answer', { fromUserId: uid_, answer });
  });
  socket.on('call:ice', ({ toUserId, candidate }) => {
    io.to('user:' + toUserId).emit('call:ice', { fromUserId: uid_, candidate });
  });
  socket.on('call:reject', ({ toUserId }) => {
    io.to('user:' + toUserId).emit('call:reject', { fromUserId: uid_ });
  });
  socket.on('call:end', ({ toUserId }) => {
    io.to('user:' + toUserId).emit('call:end', { fromUserId: uid_ });
  });

  socket.on('disconnect', () => {
    const count = (onlineUsers.get(uid_) || 1) - 1;
    if (count <= 0) {
      onlineUsers.delete(uid_);
      io.emit('presence', { userId: uid_, online: false });
    } else {
      onlineUsers.set(uid_, count);
    }
    console.log('[socket] ' + socket.user.username + ' disconnected');
  });
});

// =============================================================================
// СТАРТ
// =============================================================================
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n🚀 Мессенджер запущен на порту ' + PORT + '\n');
  const os = require('os');
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log('   LAN:  http://' + net.address + ':' + PORT);
      }
    }
  }
  console.log('   Local: http://localhost:' + PORT + '\n');
});