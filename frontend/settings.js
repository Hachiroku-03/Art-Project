// ===== 1. Global Language Setup =====
// Make language accessible to other pages immediately
window.userLanguage = localStorage.getItem('userLanguage') || 'en';
console.log('🌍 User language loaded:', window.userLanguage);

// ===== 2. Load Saved Preferences on Page Load =====
document.addEventListener('DOMContentLoaded', () => {
    // Load language
    const langSelect = document.getElementById('language-select');
    if (langSelect) {
        langSelect.value = window.userLanguage;
    }
    
    // Load notification preferences
    const notifyBids = localStorage.getItem('notifyBids');
    if (notifyBids !== null) {
        const bidsCheck = document.getElementById('notify-bids');
        if (bidsCheck) bidsCheck.checked = notifyBids === 'true';
    }
    
    const notifyComments = localStorage.getItem('notifyComments');
    if (notifyComments !== null) {
        const commentsCheck = document.getElementById('notify-comments');
        if (commentsCheck) commentsCheck.checked = notifyComments === 'true';
    }
});

// ===== 3. Save Language Preference =====
const langSelect = document.getElementById('language-select');
if (langSelect) {
    langSelect.addEventListener('change', (e) => {
        const language = e.target.value;
        localStorage.setItem('userLanguage', language);
        window.userLanguage = language; // Update global variable
        
        // Show success feedback
        const feedback = document.getElementById('save-feedback');
        if (feedback) {
            feedback.classList.add('show');
            setTimeout(() => feedback.classList.remove('show'), 2000);
        }
        console.log('✅ Language preference saved:', language);
    });
}

// ===== 4. Save Notification Preferences =====
const notifyBids = document.getElementById('notify-bids');
if (notifyBids) {
    notifyBids.addEventListener('change', (e) => {
        localStorage.setItem('notifyBids', e.target.checked);
    });
}

const notifyComments = document.getElementById('notify-comments');
if (notifyComments) {
    notifyComments.addEventListener('change', (e) => {
        localStorage.setItem('notifyComments', e.target.checked);
    });
}

// ===== 5. Header Scroll Effect =====
window.addEventListener('scroll', () => {
    const header = document.getElementById('header');
    if (header) {
        if (window.scrollY > 50) header.classList.add('scrolled');
        else header.classList.remove('scrolled');
    }
});