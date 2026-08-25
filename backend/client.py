import asyncio
import websockets
import json

async def main():
    uri = "ws://localhost:8765"
    print("Connect to Art gallery....")

    try:
        async with websockets.connect(uri) as websocket:
            print("✅ Connected! You are now in the gallery.\n")
            print("📝 Commands:")
            print("   bid [item] [price]   (e.g., bid Mona_Lisa 500)")
            print("   chat [message]       (e.g., chat Hello everyone)")
            print("   quit                 (to exit)\n")

            async def reveive_message():
                try:
                    async for message in websocket:
                        print(f"\n📢 GALLERY ANNOUNCEMENT: {message}")
                        print("You> ", end="", flush=True)

                except websockets.exceptions.ConnectionClosed:
                    pass


            async def send_message():
                
                    while True: 
                        user_input = await asyncio.get_event_loop().run_in_executor(None, input, "You: ")

                        if user_input.lower() == "quit":
                            break

                        parts = user_input.strip().split(" ", 2)

                        if not parts:
                            continue

                        action = parts[0].lower()

                        if action == "bid" and len(parts) == 3:
                            item = parts[1]
                            price = parts[2]
                            data = {"type": "bid", "item": item, "price": price}

                        elif action == "chat" and len(parts) >= 2:
                            message_text = " ".join(parts[1:])

                            data = {"type": "chat", "message": message_text}

                        else:
                            print("⚠️ Invalid command. Try 'bid [item] [price]' or 'chat [message]'")
                            continue

                        json_string = json.dumps(data)
                        await websocket.send(json_string)
                        print("Sending to server....")

            await asyncio.gather(reveive_message(),send_message())

    except ConnectionRefusedError:
        print("❌ Connection refused! Is the server running?")
    except Exception as e:
        print("An error occure: {e}")

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("Connection closed") 