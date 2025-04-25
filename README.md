# Amsterdam Flight Vibe

A relaxing web experience combining live air traffic control audio from Amsterdam Schiphol Airport (AMS) with lo-fi hip hop beats.

Visit the live site: [http://lofi-atc-ams.osint.app.com/](http://lofi-atc-ams.osint.app.com/)

## Features

- Live ATC audio stream from Schiphol Airport
- Lo-fi beats from YouTube
- Real-time flight arrivals data from Schiphol API
- Responsive design with time-of-day theming
- Live radar view via ADS-B Exchange

## Project Structure

```
amsterdam-flight-vibe/
├── .netlify/             # Netlify deployment configuration
├── netlify/
│   └── functions/        # Serverless functions for API endpoints
│       └── arrivals.js   # Flight arrivals data handler
├── public/               # Static assets (main website)
│   ├── _redirects        # Netlify redirects configuration
│   └── index.html        # Main application HTML
└── package.json          # Project dependencies
```

## Technology Stack

- Pure HTML/CSS/JavaScript frontend
- Netlify serverless functions for backend API
- Schiphol Airport API for flight data
- LiveATC.net for air traffic control audio

## Deployment

This project is deployed on Netlify. To deploy:

```bash
# Install dependencies
npm install

# Deploy to Netlify
netlify deploy --prod
```

## Environment Variables

The following environment variables need to be set in Netlify:

- `SCHIPHOL_APP_ID`: API ID for Schiphol Airport API
- `SCHIPHOL_APP_KEY`: API Key for Schiphol Airport API

## License

ISC 