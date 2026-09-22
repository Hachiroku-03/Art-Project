import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { LoginPage } from './auth/LoginPage'
import { SignupPage } from './auth/SignupPage'
import { FeedPage } from './pages/FeedPage'
import { PostRoomPage } from './pages/PostRoomPage'
import { AuctionsPage } from './pages/AuctionsPage'
import { AuctionRoomPage } from './pages/AuctionRoomPage'
import { ControlRoomPage } from './pages/ControlRoomPage'
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
        <Route path="/post/:id" element={<PostRoomPage />} />
        <Route path="/auctions" element={<AuctionsPage />} />
        <Route path="/sales/:id" element={<AuctionRoomPage />} />
        <Route path="/sales/control" element={<ControlRoomPage />} />
        <Route path="/sales/:id/control" element={<ControlRoomPage />} />
        <Route path="*" element={<Gate />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App