// ==========================================
// 0. GLOBAL SETUP
// ==========================================
window.userLanguage = localStorage.getItem('userLanguage') || 'en';

const speechLangMap = {
    'en': 'en-US', 'fr': 'fr-FR', 'es': 'es-ES', 'ja': 'ja-JP',
    'zh': 'zh-CN', 'ar': 'ar-SA', 'de': 'de-DE'
};

// ==========================================
// 1. MOCK DATA
// ==========================================
const artworksData = [
    {
        id: 1, title: "Ethereal Dreams", artist: "Alexandra Chen",
        artistAvatar: "https://i.pravatar.cc/150?img=5", style: "Abstract Expressionism",
        year: 2024, price: 2450, dimensions: "48\" × 60\"", medium: "Oil on Canvas",
        image: "https://images.unsplash.com/photo-1541963463532-d68292c34b19?w=1200",
        description: "A mesmerizing exploration of color and emotion."
    },
    {
        id: 2, title: "Chromatic Flow", artist: "Marcus Rivera",
        artistAvatar: "https://i.pravatar.cc/150?img=11", style: "Contemporary",
        year: 2023, price: 3200, dimensions: "60\" × 72\"", medium: "Acrylic on Canvas",
        image: "https://images.unsplash.com/photo-1549887534-1549e24481a6?w=1200",
        description: "Dynamic waves of color cascade across the canvas."
    }
];

const commentsData = { 1: [], 2: [] };

// ==========================================
// 2. PAGE SETUP & RENDERING
// ==========================================
function getArtworkIdFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return parseInt(params.get('id')) || 1; 
}

function getCurrentTime() {
    const now = new Date();
    return now.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function populateDetails(artwork) {
    if (!artwork) return;
    document.getElementById('detail-img').src = artwork.image;
    document.getElementById('detail-title').textContent = artwork.title;
    document.getElementById('detail-artist').textContent = artwork.artist;
    document.getElementById('detail-artist-avatar').src = artwork.artistAvatar;
    document.getElementById('detail-meta').textContent = `${artwork.style} • ${artwork.year}`;
    document.getElementById('detail-desc').textContent = artwork.description;
    document.getElementById('detail-dimensions').textContent = artwork.dimensions;
    document.getElementById('detail-medium').textContent = artwork.medium;
    document.getElementById('detail-price').textContent = `$${artwork.price.toLocaleString()}`;
}

// ==========================================
// TEXT-TO-SPEECH (TTS) LOGIC
// ==========================================
function toggleSpeech(text, lang, btnElement) {
    if (!('speechSynthesis' in window)) {
        alert("Text-to-speech is not supported in this browser.");
        return;
    }

    if (window.speechSynthesis.speaking) {
        window.speechSynthesis.cancel();
        document.querySelectorAll('.play-audio-btn').forEach(b => {
            b.innerHTML = '<i class="fas fa-volume-up"></i>';
            b.classList.remove('playing');
        });
        if (btnElement.classList.contains('playing')) return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    const ttsLangMap = { 'en': 'en-US', 'fr': 'fr-FR', 'es': 'es-ES', 'ja': 'ja-JP', 'zh': 'zh-CN', 'ar': 'ar-SA', 'de': 'de-DE' };
    utterance.lang = ttsLangMap[lang] || 'en-US';
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    utterance.onstart = () => {
        btnElement.innerHTML = '<i class="fas fa-stop"></i>';
        btnElement.classList.add('playing');
    };

    const resetBtn = () => {
        btnElement.innerHTML = '<i class="fas fa-volume-up"></i>';
        btnElement.classList.remove('playing');
    };
    utterance.onend = resetBtn;
    utterance.onerror = resetBtn;

    window.speechSynthesis.speak(utterance);
}

function createCommentComponent(comment) {
    const el = document.createElement('div');
    el.className = 'comment-component';
    el.id = `comment-${comment.id}`;
    
    const avatar = document.createElement('img');
    avatar.src = comment.avatar;
    avatar.className = 'avatar-round small';
    
    const body = document.createElement('div');
    body.className = 'comment-body';
    
    const authorLine = document.createElement('div');
    authorLine.className = 'comment-author';
    authorLine.innerHTML = `${comment.author} <span class="comment-time">${comment.time}</span>`;
    
    const text = document.createElement('p');
    text.className = 'comment-text';
    text.textContent = comment.text;
    
    const actions = document.createElement('div');
    actions.className = 'comment-actions';
    
    const likeBtn = document.createElement('button');
    likeBtn.className = `action-btn ${comment.liked ? 'liked' : ''}`;
    likeBtn.innerHTML = `<i class="${comment.liked ? 'fas' : 'far'} fa-heart"></i> ${comment.likes}`;
    likeBtn.onclick = () => toggleLike(comment.id);
    
    const playBtn = document.createElement('button');
    playBtn.className = 'action-btn play-audio-btn';
    playBtn.innerHTML = '<i class="fas fa-volume-up"></i>';
    playBtn.title = 'Listen to comment';
    playBtn.onclick = () => toggleSpeech(comment.text, window.userLanguage, playBtn);
    
    const replyBtn = document.createElement('button');
    replyBtn.className = 'action-btn';
    replyBtn.innerHTML = `<i class="far fa-comment"></i> Reply`;
    replyBtn.onclick = () => toggleReplyInput(comment.id);
    
    actions.appendChild(likeBtn);
    actions.appendChild(playBtn);
    actions.appendChild(replyBtn);
    
    body.appendChild(authorLine);
    body.appendChild(text);
    body.appendChild(actions);

    const replyContainer = document.createElement('div');
    replyContainer.className = 'reply-input-container';
    replyContainer.id = `reply-box-${comment.id}`;
    replyContainer.style.display = 'none';
    replyContainer.innerHTML = `
        <input type="text" class="reply-input" id="reply-input-${comment.id}" placeholder="Write a reply...">
        <button class="reply-send-btn" onclick="submitReply(${comment.id})">Reply</button>
        <button class="reply-cancel-btn" onclick="toggleReplyInput(${comment.id})">Cancel</button>
    `;
    body.appendChild(replyContainer);
    
    el.appendChild(avatar);
    el.appendChild(body);
    
    if (comment.replies && comment.replies.length > 0) {
        const repliesContainer = document.createElement('div');
        repliesContainer.className = 'replies-container';
        comment.replies.forEach(reply => {
            repliesContainer.appendChild(createCommentComponent(reply));
        });
        body.appendChild(repliesContainer); 
    }
    
    return el;
}

function renderComments(artworkId) {
    const list = document.getElementById('comments-list');
    const countEl = document.getElementById('comment-count');
    list.innerHTML = '';
    
    const comments = commentsData[artworkId] || [];
    countEl.textContent = `(${comments.length})`;
    
    if (comments.length === 0) {
        list.innerHTML = '<p style="color: var(--text-muted); text-align: center; padding: 20px;">No comments yet. Be the first to share your thoughts!</p>';
        return;
    }
    
    comments.forEach(comment => {
        list.appendChild(createCommentComponent(comment));
    });
    list.scrollTop = list.scrollHeight;
}

function toggleLike(commentId) {
    const artworkId = getArtworkIdFromUrl();
    const findAndToggle = (comments) => {
        for (let c of comments) {
            if (c.id === commentId) { 
                c.liked = !c.liked; 
                c.likes += c.liked ? 1 : -1; 
                if (chatWs && chatWs.readyState === WebSocket.OPEN) {
                    chatWs.send(JSON.stringify({
                        type: "like", artwork_id: artworkId, comment_id: commentId,
                        likes: c.likes, liked: c.liked, user_lang: window.userLanguage
                    }));
                }
                return true; 
            }
            if (c.replies && findAndToggle(c.replies)) return true;
        }
        return false;
    };
    findAndToggle(commentsData[artworkId]);
    renderComments(artworkId);
}

function toggleReplyInput(commentId) {
    const box = document.getElementById(`reply-box-${commentId}`);
    if (box.style.display === 'none') {
        box.style.display = 'flex';
        document.getElementById(`reply-input-${commentId}`).focus();
    } else {
        box.style.display = 'none';
        document.getElementById(`reply-input-${commentId}`).value = '';
    }
}

function submitReply(parentId) {
    const input = document.getElementById(`reply-input-${parentId}`);
    const text = input.value.trim();
    if (!text) return;
    
    const artworkId = getArtworkIdFromUrl();
    const newReply = {
        id: Date.now(), author: "You", avatar: "https://i.pravatar.cc/150?img=11",
        text: text, time: getCurrentTime(), likes: 0, liked: false, replies: []
    };

    const addReplyLocally = (comments) => {
        for (let c of comments) {
            if (c.id === parentId) { c.replies.push(newReply); return true; }
            if (c.replies && addReplyLocally(c.replies)) return true;
        }
        return false;
    };
    
    if (!commentsData[artworkId]) commentsData[artworkId] = [];
    addReplyLocally(commentsData[artworkId]);
    renderComments(artworkId);

    if (chatWs && chatWs.readyState === WebSocket.OPEN) {
        chatWs.send(JSON.stringify({
            type: "chat", artwork_id: artworkId, comment_id: newReply.id,
            author: "You", message: text, parent_id: parentId, 
            timestamp: newReply.time, user_lang: window.userLanguage
        }));
    }
}

// ==========================================
// 3. VOICE COMMENT LOGIC
// ==========================================
let recognition;
let isRecording = false;

if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = speechLangMap[window.userLanguage] || 'en-US';

    const voiceBtn = document.getElementById('voice-btn');
    const input = document.getElementById('new-comment-input');

    if (voiceBtn && input) {
        recognition.onstart = () => {
            isRecording = true;
            voiceBtn.classList.add('recording');
            voiceBtn.innerHTML = '<i class="fas fa-stop"></i>';
            input.placeholder = '🎙️ Listening... (speak now)';
        };

        recognition.onresult = (event) => {
            let transcript = '';
            for (let i = 0; i < event.results.length; i++) {
                transcript += event.results[i][0].transcript;
            }
            input.value = transcript;
        };

        recognition.onend = () => {
            isRecording = false;
            voiceBtn.classList.remove('recording');
            voiceBtn.innerHTML = '<i class="fas fa-microphone"></i>';
            input.placeholder = 'Add to the discussion...';
            
            if (input.value.trim()) {
                setTimeout(() => { document.getElementById('send-comment').click(); }, 500);
            }
        };

        recognition.onerror = (event) => {
            isRecording = false;
            voiceBtn.classList.remove('recording');
            voiceBtn.innerHTML = '<i class="fas fa-microphone"></i>';
            input.placeholder = 'Add to the discussion...';
            if (event.error === 'not-allowed') {
                alert('Microphone access denied. Please allow microphone permissions.');
            }
        };

        voiceBtn.addEventListener('click', () => {
            if (isRecording) {
                recognition.stop();
            } else {
                input.value = '';
                recognition.start();
            }
        });
    }
} else {
    const voiceBtn = document.getElementById('voice-btn');
    if (voiceBtn) {
        voiceBtn.style.display = 'none';
        voiceBtn.title = 'Not supported in this browser';
    }
}

// ==========================================
// 4. REAL-TIME WEBSOCKET LOGIC
// ==========================================
let chatWs;

function connectChatWebSocket() {
    ws = new WebSocket("wss://closure-maker-tropics.ngrok-free.app/ws");
    chatWs.onopen = () => {
        console.log("✅ Chat connected!");
        chatWs.send(JSON.stringify({ type: "init", user_lang: window.userLanguage }));
    };

    chatWs.onmessage = (event) => {
        const msg = event.data;
        const artworkId = getArtworkIdFromUrl();

        if (msg.startsWith("COMMENT_NEW|")) {
            const parts = msg.split("|");
            const msgArtworkId = parseInt(parts[1]);
            const commentId = parseInt(parts[2]);
            const author = parts[3];
            const parentIdStr = parts[4];
            const timestamp = parts[5];
            const text = parts.slice(6).join("|"); 
            const parentId = parentIdStr === "null" ? null : parseInt(parentIdStr);

            if (msgArtworkId === artworkId) {
                const newComment = {
                    id: commentId, author: author, avatar: "https://i.pravatar.cc/150?img=11",
                    text: text, time: timestamp, likes: 0, liked: false, replies: []
                };

                if (!commentsData[msgArtworkId]) commentsData[msgArtworkId] = [];

                if (parentId) {
                    const addReply = (comments) => {
                        for (let c of comments) {
                            if (c.id === parentId) { c.replies.push(newComment); return true; }
                            if (c.replies && addReply(c.replies)) return true;
                        }
                    };
                    addReply(commentsData[msgArtworkId]);
                } else {
                    commentsData[msgArtworkId].push(newComment);
                }
                renderComments(msgArtworkId);
            }
        } 
        else if (msg.startsWith("COMMENT_LIKE|")) {
            const parts = msg.split("|");
            const msgArtworkId = parseInt(parts[1]);
            const commentId = parseInt(parts[2]);
            const likes = parseInt(parts[3]);
            const liked = parts[4] === "true";

            if (msgArtworkId === artworkId) {
                const updateLike = (comments) => {
                    for (let c of comments) {
                        if (c.id === commentId) {
                            c.likes = likes; c.liked = liked; return true;
                        }
                        if (c.replies && updateLike(c.replies)) return true;
                    }
                };
                updateLike(commentsData[msgArtworkId]);
                renderComments(msgArtworkId);
            }
        }
    };

    chatWs.onclose = () => setTimeout(connectChatWebSocket, 3000);
}

document.getElementById('send-comment').addEventListener('click', () => {
    const input = document.getElementById('new-comment-input');
    const text = input.value.trim();
    if (!text) return;
    
    const artworkId = getArtworkIdFromUrl();
    const newComment = {
        id: Date.now(), author: "You", avatar: "https://i.pravatar.cc/150?img=11",
        text: text, time: getCurrentTime(), likes: 0, liked: false, replies: []
    };
    
    if (!commentsData[artworkId]) commentsData[artworkId] = [];
    commentsData[artworkId].push(newComment);
    renderComments(artworkId);
    input.value = '';

    if (chatWs && chatWs.readyState === WebSocket.OPEN) {
        chatWs.send(JSON.stringify({ 
            type: "chat", artwork_id: artworkId, comment_id: newComment.id, 
            author: "You", message: text, parent_id: "null", 
            timestamp: newComment.time, user_lang: window.userLanguage
        }));
    }
});

document.getElementById('new-comment-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') document.getElementById('send-comment').click();
});

document.addEventListener('DOMContentLoaded', () => {
    const id = getArtworkIdFromUrl();
    const artwork = artworksData.find(a => a.id === id);
    
    if (artwork) {
        populateDetails(artwork);
        loadCommentsFromDB(id); 
    }
    connectChatWebSocket(); 

    // 👇 NEW: Comments Dropdown Toggle Logic
    const commentsToggleBtn = document.getElementById('comments-toggle-btn');
    const commentsContainer = document.getElementById('comments-container');
    
    if (commentsToggleBtn && commentsContainer) {
        commentsToggleBtn.addEventListener('click', () => {
            commentsContainer.classList.toggle('open');
            commentsToggleBtn.classList.toggle('active');
        });
    }
});

// ==========================================
// 5. INITIALIZATION & DATABASE FETCH
// ==========================================

// Helper: Convert flat database rows into nested comment objects
function nestComments(flatComments) {
    const commentMap = {};
    const roots = [];
    
    flatComments.forEach(c => {
        c.replies = [];
        c.liked = false;
        c.time = c.timestamp || get.getCurrentTime();
        c.avatar = `https://i.pravatar.cc/150?img=${(c.id % 10) + 1}`;
        commentMap[c.id] = c;
    });
    
    flatComments.forEach(c => {
        if (c.parent_id && commentMap[c.parent_id]) {
            commentMap[c.parent_id].replies.push(c);
        } else {
            roots.push(c);
        }
    });
    
    return roots;
}

// Helper: Recursively translate a comment and all its replies
async function translateCommentAndReplies(comment) {
    if (comment.text && window.userLanguage !== 'en') {
        try {
            const response = await fetch("http://localhost:8000/translate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    text: comment.text,
                    target: window.userLanguage
                })
            });
            const data = await response.json();
            comment.text = data.translated || comment.text;
        } catch (error) {
            console.error("Translation failed for comment:", error);
        }
    }
    
    if (comment.replies && comment.replies.length > 0) {
        for (let reply of comment.replies) {
            await translateCommentAndReplies(reply);
        }
    }
}

// Fetch comments from the Python database on load, then translate if needed
async function loadCommentsFromDB(artworkId) {
    try {
        const response = await fetch(`http://localhost:8000/comments?artwork_id=${artworkId}`);
        const dbComments = await response.json();
        
        commentsData[artworkId] = nestComments(dbComments);
        
        // Translate each comment if the user's language is different from English
        if (window.userLanguage !== 'en') {
            for (let comment of commentsData[artworkId]) {
                await translateCommentAndReplies(comment);
            }
        }
        
        renderComments(artworkId);
    } catch (error) {
        console.error("❌ Failed to load comments from database:", error);
        renderComments(artworkId);
    }
}

window.addEventListener('scroll', () => {
    const header = document.getElementById('header');
    if (window.scrollY > 50) header.classList.add('scrolled');
    else header.classList.remove('scrolled');
});

document.addEventListener('DOMContentLoaded', () => {
    const id = getArtworkIdFromUrl();
    const artwork = artworksData.find(a => a.id === id);
    
    if (artwork) {
        populateDetails(artwork);
        loadCommentsFromDB(id); // Load from DB and translate
    }
    connectChatWebSocket(); 
});