// ===== Mock Data =====
const artworksData = [
    {
        id: 1,
        title: "Ethereal Dreams",
        artist: "Alexandra Chen",
        artistAvatar: "https://i.pravatar.cc/150?img=5",
        category: "abstract",
        price: 2450,
        likes: 234,
        views: 1205,
        image: "https://images.unsplash.com/photo-1541963463532-d68292c34b19?w=800"
    },
    {
        id: 2,
        title: "Chromatic Flow",
        artist: "Marcus Rivera",
        artistAvatar: "https://i.pravatar.cc/150?img=11",
        category: "contemporary",
        price: 3200,
        likes: 189,
        views: 980,
        image: "https://images.unsplash.com/photo-1549887534-1549e24481a6?w=800"
    },
    {
        id: 3,
        title: "Digital Consciousness",
        artist: "Sarah Kim",
        artistAvatar: "https://i.pravatar.cc/150?img=9",
        category: "digital",
        price: 1850,
        likes: 412,
        views: 2103,
        image: "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=800"
    },
    {
        id: 4,
        title: "Cosmic Reverie",
        artist: "James Morrison",
        artistAvatar: "https://i.pravatar.cc/150?img=3",
        category: "abstract",
        price: 4500,
        likes: 567,
        views: 3421,
        image: "https://images.unsplash.com/photo-1550684848-fac1c5b4e853?w=800"
    },
    {
        id: 5,
        title: "Neon Pulse",
        artist: "Elena Volkov",
        artistAvatar: "https://i.pravatar.cc/150?img=10",
        category: "digital",
        price: 2100,
        likes: 298,
        views: 1567,
        image: "https://images.unsplash.com/photo-1558591710-4b4a1ae0f0c4?w=800"
    },
    {
        id: 6,
        title: "Urban Decay",
        artist: "Michael Torres",
        artistAvatar: "https://i.pravatar.cc/150?img=13",
        category: "contemporary",
        price: 3100,
        likes: 276,
        views: 1432,
        image: "https://images.unsplash.com/photo-1561214115-f2f134cc4912?w=800"
    }
];

// ===== Component: Artwork Card =====
function createArtworkCard(artwork) {
    // Create the main card element (using <a> so it acts as a link to the detail page)
    const card = document.createElement('a');
    card.className = 'artwork-card';
    card.href = `artwork-detail.html?id=${artwork.id}`; // Links to the new page!

    // Image Container
    const imgContainer = document.createElement('div');
    imgContainer.className = 'artwork-card-image';
    
    const img = document.createElement('img');
    img.src = artwork.image;
    img.alt = artwork.title;
    imgContainer.appendChild(img);

    // Info Container
    const infoContainer = document.createElement('div');
    infoContainer.className = 'artwork-card-info';

    // Header (Title & Price)
    const header = document.createElement('div');
    header.className = 'artwork-card-header';
    
    const title = document.createElement('h3');
    title.className = 'artwork-title';
    title.textContent = artwork.title;
    
    const price = document.createElement('p');
    price.className = 'artwork-price';
    price.textContent = `$${artwork.price.toLocaleString()}`;
    
    header.appendChild(title);
    header.appendChild(price);

    // Artist Profile
    const artistProfile = document.createElement('div');
    artistProfile.className = 'artist-mini-profile';
    
    const avatar = document.createElement('img');
    avatar.src = artwork.artistAvatar;
    avatar.alt = artwork.artist;
    avatar.className = 'avatar-round';
    
    const artistName = document.createElement('span');
    artistName.className = 'artist-name-mini';
    artistName.textContent = artwork.artist;
    
    artistProfile.appendChild(avatar);
    artistProfile.appendChild(artistName);

    // Stats
    const stats = document.createElement('div');
    stats.className = 'artwork-stats-mini';
    stats.innerHTML = `
        <span class="stat-item"><i class="fas fa-heart"></i> ${artwork.likes}</span>
        <span class="stat-item"><i class="fas fa-eye"></i> ${artwork.views}</span>
    `;

    // Assemble the card
    infoContainer.appendChild(header);
    infoContainer.appendChild(artistProfile);
    infoContainer.appendChild(stats);
    
    card.appendChild(imgContainer);
    card.appendChild(infoContainer);

    return card;
}

// ===== Render Gallery =====
function renderGallery(filter = 'all', sortBy = 'newest', searchTerm = '') {
    const grid = document.getElementById('gallery-grid');
    grid.innerHTML = ''; // Clear current grid

    let filtered = artworksData;

    // 1. Filter by Category
    if (filter !== 'all') {
        filtered = filtered.filter(art => art.category === filter);
    }

    // 2. Filter by Search
    if (searchTerm) {
        const term = searchTerm.toLowerCase();
        filtered = filtered.filter(art => 
            art.title.toLowerCase().includes(term) || 
            art.artist.toLowerCase().includes(term)
        );
    }

    // 3. Sort
    switch(sortBy) {
        case 'price-low':
            filtered.sort((a, b) => a.price - b.price);
            break;
        case 'price-high':
            filtered.sort((a, b) => b.price - a.price);
            break;
        case 'popular':
            filtered.sort((a, b) => b.likes - a.likes);
            break;
        default: // newest
            filtered.sort((a, b) => b.id - a.id);
    }

    // 4. Render
    if (filtered.length === 0) {
        grid.innerHTML = '<p style="grid-column: 1/-1; text-align: center; color: var(--text-muted);">No artworks found.</p>';
    } else {
        filtered.forEach(artwork => {
            grid.appendChild(createArtworkCard(artwork));
        });
    }
}

// ===== Event Listeners =====
document.addEventListener('DOMContentLoaded', () => {
    // Initial Render
    renderGallery();

    // Filter Buttons
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            
            const filter = e.target.dataset.filter;
            const sort = document.getElementById('sort-select').value;
            const search = document.getElementById('search-input').value;
            renderGallery(filter, sort, search);
        });
    });

    // Sort Dropdown
    document.getElementById('sort-select').addEventListener('change', (e) => {
        const filter = document.querySelector('.filter-btn.active').dataset.filter;
        const search = document.getElementById('search-input').value;
        renderGallery(filter, e.target.value, search);
    });

    // Search Input
    document.getElementById('search-input').addEventListener('input', (e) => {
        const filter = document.querySelector('.filter-btn.active').dataset.filter;
        const sort = document.getElementById('sort-select').value;
        renderGallery(filter, sort, e.target.value);
    });
});