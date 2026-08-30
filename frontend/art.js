// ===== Header Scroll Effect =====
const header = document.getElementById('header');

window.addEventListener('scroll', () => {
    if (window.scrollY > 100) {
        header.classList.add('scrolled');
    } else {
        header.classList.remove('scrolled');
    }
});

// ===== Mobile Navigation =====
const burger = document.getElementById('burger');
const navLinks = document.getElementById('navLinks');

burger.addEventListener('click', () => {
    navLinks.classList.toggle('active');
    burger.classList.toggle('toggle');
});

// Close mobile menu when clicking a link
document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', () => {
        navLinks.classList.remove('active');
        burger.classList.remove('toggle');
    });
});

// ===== Smooth Scroll for Anchor Links =====
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function(e) {
        e.preventDefault();
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
            target.scrollIntoView({
                behavior: 'smooth',
                block: 'start'
            });
        }
    });
});

// ===== Intersection Observer for Fade-in Animations =====
const observerOptions = {
    threshold: 0.1,
    rootMargin: '0px 0px -50px 0px'
};

const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('fade-in');
            observer.unobserve(entry.target);
        }
    });
}, observerOptions);

// Observe all sections
document.querySelectorAll('section').forEach(section => {
    observer.observe(section);
});

// ===== WebSocket Connection (For Live Auction & Chat) =====
let ws;

function connectWebSocket() {
    ws = new WebSocket("ws://localhost:8765");

    ws.onopen = () => {
        console.log("✅ Connected to THE SPACE Server!");
    };

    ws.onmessage = (event) => {
        const message = event.data;
        console.log("📩 Received:", message);

        // Update auction price if it's a bid
        if (message.includes("NEW BID")) {
            const priceElement = document.getElementById('auction-price');
            if (priceElement) {
                // Extract price from message
                const priceMatch = message.match(/\$(\d+)/);
                if (priceMatch) {
                    priceElement.textContent = `$${priceMatch[1]}`;
                    // Add pulse animation
                    priceElement.style.animation = 'pulse 0.5s ease';
                    setTimeout(() => {
                        priceElement.style.animation = '';
                    }, 500);
                }
            }
        }
    };

    ws.onerror = (error) => {
        console.error("❌ WebSocket Error:", error);
    };

    ws.onclose = () => {
        console.log("🔌 Connection closed. Reconnecting...");
        setTimeout(connectWebSocket, 3000);
    };
}

// Try to connect (will fail gracefully if server isn't running)
try {
    connectWebSocket();
} catch (error) {
    console.log("WebSocket not available yet");
}

// ===== Auction Timer (Countdown) =====
function updateAuctionTimer() {
    const timerElement = document.getElementById('auction-timer');
    if (!timerElement) return;

    // Set a future date (2 hours from now for demo)
    const endTime = new Date();
    endTime.setHours(endTime.getHours() + 2);

    function update() {
        const now = new Date();
        const diff = endTime - now;

        if (diff <= 0) {
            timerElement.textContent = "Auction Ended";
            return;
        }

        const hours = Math.floor(diff / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((diff % (1000 * 60)) / 1000);

        timerElement.textContent = 
            `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }

    update();
    setInterval(update, 1000);
}

updateAuctionTimer();

// ===== Contact Form Handler =====
const contactForm = document.querySelector('.contact-form');
if (contactForm) {
    contactForm.addEventListener('submit', (e) => {
        e.preventDefault();
        
        // Get form data
        const formData = new FormData(contactForm);
        const name = contactForm.querySelector('input[type="text"]').value;
        const email = contactForm.querySelector('input[type="email"]').value;
        const message = contactForm.querySelector('textarea').value;

        // For now, just show an alert (we'll connect to backend later)
        alert(`Thank you ${name}! Your message has been received. We'll contact you at ${email} soon.`);
        
        // Reset form
        contactForm.reset();
    });
}

// ===== Newsletter Form Handler =====
const newsletterForm = document.querySelector('.newsletter-form');
if (newsletterForm) {
    newsletterForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const email = newsletterForm.querySelector('input[type="email"]').value;
        alert(`Thank you for subscribing! We'll send updates to ${email}`);
        newsletterForm.reset();
    });
}

console.log("🎨 THE SPACE is live!");