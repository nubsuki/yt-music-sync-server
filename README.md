# YouTube Music Sync Server (Listen Along)

This is the backend server for the **Listen Along** feature of the [YouTube Music Player](https://github.com/nubsuki/YouTube-Music-Player) desktop application. It acts as a real-time bridge using Socket.IO, allowing a host to broadcast their current playback state and guests to sync to it effortlessly.

It also serves a public web dashboard where anyone can view active parties and their currently playing tracks.

## Features

- **Real-time Synchronization:** Sub-second playback sync via Socket.IO.
- **Web Dashboard:** Beautiful public UI to see live parties and now playing status.

---

## Getting Started

### Docker Deployment

The easiest way to host this in production is using Docker Compose.

1. Build and start the container:
   ```bash
   docker-compose up -d --build
   ```
2. View the logs:
   ```bash
   docker-compose logs -f
   ```
3. To stop the container:
   ```bash
   docker-compose down
   ```

---

## Environment Variables

You can configure the server using a `.env` file or by passing environment variables:

| Variable      | Default       | Description                                                                           |
| ------------- | ------------- | ------------------------------------------------------------------------------------- |
| `PORT`        | `3000`        | The port the server runs on.                                                          |
| `MAX_MEMBERS` | `50`          | Maximum number of listeners allowed per party.                                        |
| `MAX_PARTIES` | `500`         | Maximum number of concurrent active parties server-wide to prevent memory exhaustion. |
| `NODE_ENV`    | `development` | Set to `production` when deploying.                                                   |

---

## API Endpoints

### REST API

- `POST /api/party/create` - Creates a new party, returns `partyId` and `hostToken`.
- `GET /api/parties` - Lists all currently active parties.
- `GET /api/party/:id` - Gets info about a specific party.
- `DELETE /api/party/:id` - Closes a party (requires matching `hostToken`).

### Web Pages (Served by Express)

- `GET /` - The public dashboard showing all active parties.
- `GET /party/:id` - The public view for a specific party, showing live sync status.

## License

- This software is provided "as-is" without any warranties or guarantees.
