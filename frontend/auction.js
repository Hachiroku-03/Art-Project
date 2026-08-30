// ===== 1. Mock Auction Data =====
const currentAuction = {
    id: 1,
    title: "Cosmic Reverie",
    artist: "James Morrison",
    artistAvatar: "https://i.pravatar.cc/150?img=3",
    style: "Surrealism",
    year: 2023,
    image: "https://images.unsplash.com/photo-1550684848-fac1c5b4e853?w=1200",
    startingPrice: 1000
};

// ===== 2. Populate Initial UI =====
function initAuctionUI() {
    document.getElementById('auction-img').src = currentAuction.image;
    document.getElementById('auction-title').textContent = currentAuction.title;
    document.getElementById('auction-artist').textContent = currentAuction.artist;
    document.getElementById('auction-artist-avatar').src = currentAuction.artistAvatar;
    document.getElementById('auction-style').textContent = `${currentAuction.style} • ${currentAuction.year}`;
    document.getElementById('current-price').textContent = `$${currentAuction.startingPrice.toLocaleString()}`;
    startTimer(2, 15, 30);
}

// ===== 3. Timer Logic =====
function startTimer(hours, minutes, seconds) {
    let totalSeconds = (hours * 3600) + (minutes * 60) + seconds;
    const timerEl = document.getElementById('auction-timer');

    const interval = setInterval(() => {
        if (totalSeconds <= 0) {
            clearInterval(interval);
            timerEl.textContent = "AUCTION ENDED";
            document.getElementById('place-bid-btn').disabled = true;
            return;
        }
        totalSeconds--;
        const h = Math.floor(totalSeconds / 3600);
        const m = Math.floor((totalSeconds % 3600) / 60);
        const s = totalSeconds % 60;
        timerEl.textContent = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }, 1000);
}

// ===== 4. WebSocket Connection =====
const statusDot = document.querySelector('.status-dot');
const statusText = document.querySelector('#connection-status');
const bidFeed = document.getElementById('bid-feed');
const priceEl = document.getElementById('current-price');
let ws;

function connectWebSocket() {
    ws = new WebSocket("ws://localhost:8000/ws");

    ws.onopen = () => {
        console.log("✅ Connected to Auction Server!");
        statusDot.classList.add('connected');
        statusText.innerHTML = '<span class="status-dot connected"></span> Live Connection Active';
        addFeedItem("System", "Connected to live auction server.", true);
    };

    ws.onmessage = (event) => {
        const message = event.data;
        console.log("📩 Server broadcast:", message);

        // 🚨 1. CHECK FOR ERRORS FIRST 🚨
        if (message.startsWith("ERROR:")) {
            const feedback = document.getElementById('bid-feedback');
            feedback.textContent = message;
            feedback.style.color = "#ff4444";
            addFeedItem("System", message, true);
            return; // Stop here, don't update the price!
        }

        // 🚨 2. IF SUCCESS, UPDATE PRICE 🚨
        const priceMatch = message.match(/\$(\d+)/);
        if (priceMatch) {
            const newPrice = parseInt(priceMatch[1]);
            priceEl.textContent = `$${newPrice.toLocaleString()}`;
            
            // Flash effect
            priceEl.style.color = '#00ff88';
            setTimeout(() => priceEl.style.color = 'var(--text-main)', 500);
        }

        addFeedItem("Live Update", message, false);
    };

    ws.onerror = (error) => {
        console.error("❌ WebSocket Error:", error);
        statusText.innerHTML = '<span class="status-dot"></span> Connection Failed.';
    };

    ws.onclose = () => {
        console.log("🔌 Disconnected. Reconnecting in 3s...");
        statusText.innerHTML = '<span class="status-dot"></span> Reconnecting...';
        setTimeout(connectWebSocket, 3000);
    };
}

// ===== 5. UI Helper: Add to Feed =====
function addFeedItem(author, text, isSystem) {
    if (!isSystem && bidFeed.querySelector('.system')) {
        bidFeed.innerHTML = '';
    }
    const item = document.createElement('div');
    item.className = `feed-item ${isSystem ? 'system' : 'new-bid'}`;
    item.innerHTML = `<strong>${author}:</strong> ${text}`;
    bidFeed.appendChild(item);
    bidFeed.scrollTop = bidFeed.scrollHeight;
}

// ===== 6. Handle User Bid =====
document.getElementById('place-bid-btn').addEventListener('click', () => {
    const input = document.getElementById('bid-amount');
    const price = input.value.trim();
    const feedback = document.getElementById('bid-feedback');

    if (!price || isNaN(price) || price <= 0) {
        feedback.textContent = "Please enter a valid bid amount.";
        feedback.style.color = "#ff4444";
        return;
    }

    // 🚨 FRONTEND VALIDATION: Check against the screen price 🚨
    const currentPriceText = document.getElementById('current-price').textContent;
    const currentPrice = parseInt(currentPriceText.replace(/[$,]/g, ''));

    if (parseInt(price) <= currentPrice) {
        feedback.textContent = `Bid must be higher than $${currentPrice.toLocaleString()}!`;
        feedback.style.color = "#ff4444";
        return;
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
        const bidData = {
            type: "bid",
            item: currentAuction.title,
            price: price
        };
        
        ws.send(JSON.stringify(bidData));
        
        feedback.textContent = "Bid placed! Waiting for server confirmation...";
        feedback.style.color = "#00ff88";
        input.value = ''; 
    } else {
        feedback.textContent = "Server disconnected. Cannot place bid.";
        feedback.style.color = "#ff4444";
    }
});

// ===== 7. Header Scroll Effect =====
window.addEventListener('scroll', () => {
    const header = document.getElementById('header');
    if (window.scrollY > 50) header.classList.add('scrolled');
    else header.classList.remove('scrolled');
});

// ===== 8. Initialize =====
document.addEventListener('DOMContentLoaded', () => {
    initAuctionUI();
    connectWebSocket();
});