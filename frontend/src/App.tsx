import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { LoginPage } from './auth/LoginPage'
import { SignupPage } from './auth/SignupPage'
import { FeedPage } from './pages/FeedPage'
import { PostRoomPage } from './pages/PostRoomPage' // ← NEW IMPORT
// import {CreatePage} from './pages/CreatePage'
// import { StubPage } from './pages/StubPage'

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
        <Route path="/post/:id" element={<PostRoomPage />} /> {/* ← UPDATED ROUTE */}
        {/* <Route path="/create" element={<CreatePage />} /> */}
        {/* <Route path="/auctions" element={<StubPage title="Auctions" />} />
        <Route path="/community" element={<StubPage title="Community" />} />
        <Route path="/studio" element={<StubPage title="Studio" />} />
        <Route path="/discover" element={<StubPage title="Discover" />} />
        <Route path="/profile" element={<StubPage title="Profile" />} />
        <Route path="/settings" element={<StubPage title="Settings" />} />
        <Route path="/messages" element={<StubPage title="Messages" />} /> */}
        <Route path="*" element={<Gate />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App