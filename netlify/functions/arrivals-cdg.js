const axios = require('axios');

// Cache per airport
const flightCaches = {};
const CACHE_MS = 5 * 60 * 1000; // 5 min

exports.handler = async function(event, context) {
    const queryParams = event.queryStringParameters || {};
    const cacheKey = (queryParams.arr_iata || 'CDG').toUpperCase();

    // Check cache
    const cached = flightCaches[cacheKey];
    if (cached && (Date.now() - cached.time) < CACHE_MS) {
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, s-maxage=60' },
            body: JSON.stringify({ ...cached.data, cached: true, cacheAge: Math.round((Date.now() - cached.time) / 1000) })
        };
    }

    const apiKey = process.env.AVIATIONSTACK_API_KEY;
    if (!apiKey) {
        return { statusCode: 500, body: JSON.stringify({ error: 'No API key configured' }) };
    }

    // Support any airport via query param (default CDG)
    const queryParams = event.queryStringParameters || {};
    const arrIata = (queryParams.arr_iata || 'CDG').toUpperCase();

    try {
        // Fetch scheduled + active arrivals
        const [scheduled, active, landed] = await Promise.all([
            axios.get('http://api.aviationstack.com/v1/flights', {
                params: { access_key: apiKey, arr_iata: arrIata, flight_status: 'scheduled', limit: 100 }
            }).catch(() => ({ data: { data: [] } })),
            axios.get('http://api.aviationstack.com/v1/flights', {
                params: { access_key: apiKey, arr_iata: arrIata, flight_status: 'active', limit: 100 }
            }).catch(() => ({ data: { data: [] } })),
            axios.get('http://api.aviationstack.com/v1/flights', {
                params: { access_key: apiKey, arr_iata: arrIata, flight_status: 'landed', limit: 50 }
            }).catch(() => ({ data: { data: [] } })),
        ]);

        const allRaw = [
            ...(landed.data?.data || []),
            ...(active.data?.data || []),
            ...(scheduled.data?.data || []),
        ];

        // Deduplicate by flight iata code
        const seen = new Set();
        const flights = [];
        for (const f of allRaw) {
            const key = f.flight?.iata || f.flight?.icao || Math.random().toString();
            if (seen.has(key)) continue;
            seen.add(key);

            // Skip codeshares
            if (f.flight?.codeshared) continue;

            const arrTime = f.arrival?.scheduled || f.arrival?.estimated || '';
            flights.push({
                flightName: f.flight?.iata || f.flight?.icao || '',
                scheduleDateTime: arrTime,
                scheduleTime: arrTime ? arrTime.slice(11, 16) : '',
                airline: {
                    name: f.airline?.name || '',
                    iata: f.airline?.iata || '',
                    icao: f.airline?.icao || '',
                },
                departure: {
                    airport: f.departure?.airport || '',
                    iata: f.departure?.iata || '',
                    city: f.departure?.airport || '',
                },
                aircraft: {
                    iata: f.aircraft?.iata || '',
                    icao: f.aircraft?.icao || '',
                },
                arrival: {
                    terminal: f.arrival?.terminal || '',
                    gate: f.arrival?.gate || '',
                    delay: f.arrival?.delay || null,
                },
                status: f.flight_status || 'scheduled',
            });
        }

        // Sort by arrival time
        flights.sort((a, b) => (a.scheduleDateTime || '').localeCompare(b.scheduleDateTime || ''));

        const result = {
            flights,
            meta: { totalFlights: flights.length, airport: 'CDG', timestamp: new Date().toISOString() }
        };

        flightCaches[arrIata] = { data: result, time: Date.now() };

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, s-maxage=60' },
            body: JSON.stringify(result)
        };
    } catch (err) {
        console.error('CDG arrivals error:', err.message);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: err.message, flights: [] })
        };
    }
};
