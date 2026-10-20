import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { LoginPage } from './auth/LoginPage'
import { SignupPage } from './auth/SignupPage'
import { FeedPage } from './pages/FeedPage'
import { PostRoomPage } from './pages/PostRoomPage'
import { AuctionsPage } from './pages/AuctionsPage'
import { AuctionRoomPage } from './pages/AuctionRoomPage'
import { ControlRoomPage } from './pages/ControlRoomPage'
import { HouseApplicationPage } from './pages/HouseApplicationPage'
import { PricingPage } from './pages/PricingPage'
import { ProfilePage } from './pages/ProfilePage'
import { ErrorBoundary } from './components/ErrorBoundary'
import { WalletPage } from './pages/WalletPage'
import { ChatDebugPage } from './pages/ChatDebugPage'
import { MessengerPage } from './pages/MessengerPage'
import { NotificationsPage } from './pages/NotificationsPage'
import { SettingsPage } from './pages/SettingsPage'
import { CommunityPage } from './pages/CommunityPage'
import { CallDetailPage } from './pages/CallDetailPage'
// AuctionFloorPage / LiveRoomPage intentionally NOT routed: we reuse your
// existing AuctionsPage (floor) and AuctionRoomPage (room). The files remain on
// disk; repoint a route here if you'd rather use them instead.
import { SaleDetailPage } from './pages/SaleDetailPage'
import { WonLotsPage } from './pages/WonLotsPage'

function Gate() {
  const token = localStorage.getItem('space_token')
  return <Navigate to={token ? '/feed' : '/login'} replace />
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/feed" element={<FeedPage />} />
        <Route path="/community" element={<CommunityPage />} />
        <Route path="/post/:id" element={<PostRoomPage />} />

        {/* floor: keep your existing page (was duplicated with AuctionFloorPage) */}
        <Route path="/auctions" element={<AuctionsPage />} />

        {/* control room (static segment outranks params in v6, so /sales/control is safe) */}
        <Route path="/sales/control" element={<ControlRoomPage />} />

        {/* ticket page: the NEW missing surface (was shadowed by old /sales/:id) */}
        <Route path="/sales/:saleId" element={<SaleDetailPage />} />

        {/* room: your existing AuctionRoomPage, MOVED off /sales/:id so it no
            longer shadows the ticket page. SaleDetailPage's Enter room -> here. */}
        <Route path="/sales/:id/room" element={<AuctionRoomPage />} />

        <Route path="/sales/:id/control" element={<ControlRoomPage />} />

        <Route path="/house/apply" element={<HouseApplicationPage />} />
        <Route path="/pricing" element={<PricingPage />} />
        <Route path="/wallet" element={<WalletPage />} />
        <Route path="/messenger" element={<MessengerPage />} />
        <Route path="/chat-debug" element={<ChatDebugPage />} />
        <Route path="/notifications" element={<NotificationsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/wins"element={<ErrorBoundary><WonLotsPage /></ErrorBoundary>}/>
        <Route path="/calls/:id" element={<CallDetailPage />} />
        <Route path="/profile" element={<ErrorBoundary><ProfilePage /></ErrorBoundary>} />
        <Route path="/profile/:username" element={<ErrorBoundary><ProfilePage /></ErrorBoundary>} />
        <Route path="*" element={<Gate />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App