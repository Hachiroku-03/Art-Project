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
import {CommunityPage} from './pages/CommunityPage'
import { CallDetailPage } from './pages/CallDetailPage'
// SalesRoomPage removed — /sales/:id now renders AuctionRoomPage

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
        <Route path="/auctions" element={<AuctionsPage />} />
        <Route path="/sales/:id" element={<AuctionRoomPage />} />
        <Route path="/sales/control" element={<ControlRoomPage />} />
        <Route path="/sales/:id/control" element={<ControlRoomPage />} />     
        <Route path="/house/apply" element={<HouseApplicationPage />} />
        <Route path="/pricing" element={<PricingPage />} />
        <Route path="/wallet" element={<WalletPage />} />
        <Route path="/messenger" element={<MessengerPage />} />
        <Route path="/chat-debug" element={<ChatDebugPage />} />
        <Route path="/notifications" element={<NotificationsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/calls/:id" element={<CallDetailPage />} />
        <Route path="/profile/:username" element={<ErrorBoundary><ProfilePage /></ErrorBoundary>} />
        <Route path="*" element={<Gate />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App