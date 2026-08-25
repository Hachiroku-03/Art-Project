import asyncio
import websockets
import json

connected_clients = set()

async def handler(websocket):
    connected_clients.add(websocket)
    print(f"Connect clients: {len(connected_clients)}")

    try:
      async for message in websocket:
        data = json.loads(message)

        if data.get("type") == "bid":
           item = data.get("item")
           price = data.get("price")
           print("")

           broadcast_msg = f"Alert🚨 NEW BIDS {item} {price}"
           print(f"Server processing {broadcast_msg}")

           for client in connected_clients:           
             if client != websocket:
                await client.send(broadcast_msg)

        elif data.get("type") == "chat":
           pass

    except websockets.exceptions.ConnectionClosed:
       print("A vistor just left the gallery")
    finally:
       connected_clients.remove(websocket)

async def main():

   async with websockets.serve(handler, "localhost", 8765):
      print("Server online: ws://localhost:8765")

      await asyncio.Event().wait()

if __name__ == "__main__":
   try:
      asyncio.run(main())
   except KeyboardInterrupt:
      print("Server stopped")
      


    