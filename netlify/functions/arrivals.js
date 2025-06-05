// Netlify serverless function for Schiphol API
const axios = require('axios');
const { format, addHours, subHours, parseISO } = require('date-fns');

// Cache for airport data
let airportCache = new Map();
let lastCacheUpdate = null;
const CACHE_DURATION = 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds for free tier

// Cache for flight data
let flightDataCache = new Map();
const FLIGHT_CACHE_DURATION = 15 * 60 * 1000; // 15 minutes in milliseconds

// Cache structure for flights
// Key: date_timewindow (e.g., "2024-03-20_morning")
// Value: { data: {...}, timestamp: Date.now() }

let apiCallsCount = 0;
const MAX_API_CALLS = 90; // Keep some buffer from the 100 limit

// Helper function to get country flag emoji from country code
function getFlagEmoji(countryCode) {
    if (!countryCode) {
        return "";
    }
    
    // Convert country code to uppercase if not already
    const code = countryCode.toUpperCase();
    
    // Calculate the unicode codepoints for the regional indicator symbols
    return String.fromCodePoint(0x1F1E6 + code.charCodeAt(0) - 65) + 
           String.fromCodePoint(0x1F1E6 + code.charCodeAt(1) - 65);
}

// Dictionary of IATA airport codes to cities and countries
const airportInfo = {
    "AMS": {"city": "Amsterdam", "country": "NL"},
    "LIN": {"city": "Milan", "country": "IT"},
    "BHX": {"city": "Birmingham", "country": "GB"},
    "LPA": {"city": "Gran Canaria", "country": "ES"},
    "BOM": {"city": "Mumbai", "country": "IN"},
    "MUC": {"city": "Munich", "country": "DE"},
    "ORD": {"city": "Chicago", "country": "US"},
    "IST": {"city": "Istanbul", "country": "TR"},
    "NCE": {"city": "Nice", "country": "FR"},
    "OPO": {"city": "Porto", "country": "PT"},
    "SVQ": {"city": "Seville", "country": "ES"},
    "PSA": {"city": "Pisa", "country": "IT"},
    "RAK": {"city": "Marrakech", "country": "MA"},
    "AYT": {"city": "Antalya", "country": "TR"},
    "HER": {"city": "Heraklion", "country": "GR"},
    "SPC": {"city": "Santa Cruz de La Palma", "country": "ES"},
    "LIS": {"city": "Lisbon", "country": "PT"},
    "VLC": {"city": "Valencia", "country": "ES"}
};

// Helper function to extract next page URL from Link header
function getNextPageUrl(headers) {
    if (!headers.link) {
        return null;
    }
    
    const links = headers.link.split(',').map(link => link.trim());
    
    for (const link of links) {
        if (link.includes('rel="next"')) {
            const urlStart = link.indexOf('<') + 1;
            const urlEnd = link.indexOf('>');
            if (urlStart > 0 && urlEnd > 0) {
                let nextUrl = link.substring(urlStart, urlEnd);
                if (nextUrl.includes('protocol://')) {
                    nextUrl = nextUrl.replace('protocol://server_address:port', 'https://api.schiphol.nl');
                } else if (nextUrl.startsWith('/')) {
                    nextUrl = `https://api.schiphol.nl${nextUrl}`;
                }
                return nextUrl;
            }
        }
    }
    
    return null;
}

// Function to fetch airport data from Aviation Stack API
async function fetchAirportData(iataCode) {
    if (airportCache.has(iataCode)) {
        const cachedData = airportCache.get(iataCode);
        if (lastCacheUpdate && (Date.now() - lastCacheUpdate) < CACHE_DURATION) {
            return cachedData;
        }
    }

    if (apiCallsCount >= MAX_API_CALLS) {
        await fetchOpenFlightsData();
        return airportCache.get(iataCode);
    }

    try {
        const response = await axios.get(`http://api.aviationstack.com/v1/airports`, {
            params: {
                access_key: process.env.AVIATIONSTACK_API_KEY,
                iata_code: iataCode
            }
        });

        apiCallsCount++;

        if (response.data && response.data.data && response.data.data.length > 0) {
            const airportData = response.data.data[0];
            const result = {
                city: airportData.city_name,
                country: airportData.country_iso2,
                name: airportData.airport_name,
                source: 'aviationstack'
            };

            airportCache.set(iataCode, result);
            if (!lastCacheUpdate) lastCacheUpdate = Date.now();

            return result;
        }
        return null;
    } catch (error) {
        console.error(`Error fetching airport data for ${iataCode}:`, error.message);
        await fetchOpenFlightsData();
        return airportCache.get(iataCode);
    }
}

// Batch process IATA codes to minimize API calls
async function batchFetchAirportData(iataCodes) {
    // First, filter out codes we already have in cache
    const uncachedCodes = iataCodes.filter(code => !airportCache.has(code));
    
    if (uncachedCodes.length === 0) {
        return;
    }

    // If we're near API limit, use OpenFlights for all
    if (apiCallsCount + uncachedCodes.length > MAX_API_CALLS) {
        await fetchOpenFlightsData();
        return;
    }

    // Fetch each uncached airport
    for (const code of uncachedCodes) {
        await fetchAirportData(code);
    }
}

// Fallback to OpenFlights data if API fails
async function fetchOpenFlightsData() {
    try {
        // Only fetch if cache is empty or expired
        if (airportCache.size === 0 || !lastCacheUpdate || (Date.now() - lastCacheUpdate) >= CACHE_DURATION) {
            const response = await axios.get('https://raw.githubusercontent.com/jpatokal/openflights/master/data/airports.dat');
            const airports = response.data.split('\n')
                .map(line => {
                    const parts = line.split(',');
                    if (parts.length >= 5) {
                        return {
                            iata: parts[4].replace(/"/g, ''),
                            city: parts[2].replace(/"/g, ''),
                            country: parts[3].replace(/"/g, ''),
                            name: parts[1].replace(/"/g, '')
                        };
                    }
                    return null;
                })
                .filter(airport => airport && airport.iata.length === 3);

            // Update cache
            airports.forEach(airport => {
                airportCache.set(airport.iata, {
                    city: airport.city,
                    country: airport.country,
                    name: airport.name
                });
            });
            lastCacheUpdate = Date.now();
        }
    } catch (error) {
        console.error('Error fetching OpenFlights data:', error.message);
    }
}

// Enhanced processFlightData function
async function processFlightData(flights) {
    // Extract all unique IATA codes first
    const iataCodes = new Set();
    flights.forEach(flight => {
        if (flight.route?.destinations?.[0]) {
            const match = flight.route.destinations[0].match(/\(([A-Z]{3})\)/);
            if (match) {
                iataCodes.add(match[1]);
            }
        }
    });

    // Batch fetch airport data
    await batchFetchAirportData([...iataCodes]);

    // Now process each flight
    return Promise.all(flights.map(async flight => {
        if (flight.route?.destinations?.[0]) {
            const destination = flight.route.destinations[0];
            let iataCode = null;

            // Extract IATA code
            const match = destination.match(/\(([A-Z]{3})\)/);
            if (match) {
                iataCode = match[1];
            }

            if (iataCode && airportCache.has(iataCode)) {
                const airportData = airportCache.get(iataCode);
                flight.cityInfo = {
                    city: airportData.city,
                    country: airportData.country,
                    flag: getFlagEmoji(airportData.country),
                    airportName: airportData.name,
                    source: airportData.source
                };

                // Update the destination display if we have better information
                if (!destination.includes('(')) {
                    flight.route.destinations[0] = `${airportData.city} (${iataCode})`;
                }
            }
        }
        return flight;
    }));
}

// Enhanced time window definitions - centralizing for easier management
const TIME_WINDOWS = {
    morning: {
        displayName: 'Morning Arrivals',
        startTime: '06:00',
        endTime: '11:59',
        description: '6AM-12PM'
    },
    afternoon: {
        displayName: 'Afternoon Arrivals',
        startTime: '12:00',
        endTime: '17:59',
        description: '12PM-6PM'
    },
    evening: {
        displayName: 'Evening Arrivals',
        startTime: '18:00',
        endTime: '21:59',
        description: '6PM-10PM'
    },
    night: {
        displayName: 'Night Arrivals',
        startTime: '22:00',
        endTime: '23:59',
        description: '10PM-12AM'
    },
    early_morning: {
        displayName: 'Early Morning Arrivals',
        startTime: '00:00',
        endTime: '05:59',
        description: '12AM-6AM'
    },
    current: {
        displayName: 'Current Arrivals',
        dynamicWindow: true,
        description: 'Now ±2 hours'
    }
};

// Function to handle parameter validation based on OpenAPI schema
function validateAndCleanParams(params) {
    // Valid parameters for /flights endpoint according to schema
    const validParams = [
        'scheduleDate', 'scheduleTime', 'flightName', 'flightDirection',
        'airline', 'airlineCode', 'route', 'includedelays', 'page',
        'sort', 'fromDateTime', 'toDateTime', 'searchDateTimeField',
        'fromScheduleDate', 'toScheduleDate', 'isOperationalFlight'
    ];
    
    const cleanedParams = {};
    
    // Filter out any invalid parameters
    Object.keys(params).forEach(key => {
        if (validParams.includes(key)) {
            cleanedParams[key] = params[key];
        }
    });
    
    // Ensure flightDirection is always set for arrivals
    cleanedParams.flightDirection = 'A';
    
    return cleanedParams;
}

// Function to estimate starting page based on time of day
function estimateStartingPage(nlTime) {
    const hour = nlTime.getHours();
    const minute = nlTime.getMinutes();
    
    // More aggressive estimation:
    // Assuming ~40 flights per hour (based on real data)
    // With 20 flights per page, that's 2 pages per hour
    let hoursFromStart = hour - 6;
    if (hoursFromStart < 0) hoursFromStart += 24;
    
    // More aggressive page estimation
    // Add minute-based adjustment for more precision
    // This will help start even later in the hour
    const hourBasedPage = hoursFromStart * 2; // 2 pages per hour
    const minuteAdjustment = Math.floor((minute / 60) * 2); // Up to 2 more pages based on minutes
    
    const estimatedPage = Math.max(0, Math.floor(hourBasedPage + minuteAdjustment));
    
    // Example calculations:
    // At 16:57:
    // hoursFromStart = 11 (16 - 6 = 10 hours)
    // hourBasedPage = 22 (11 * 2)
    // minuteAdjustment = 1.9 (57/60 * 2 ≈ 1.9)
    // Total: page 23-24
    
    return estimatedPage;
}

// Function to check if a flight is in the future
function isFlightInFuture(flight, currentTime) {
    if (!flight.scheduleDate || !flight.scheduleTime) return false;
    try {
        const scheduleDatetime = new Date(`${flight.scheduleDate}T${flight.scheduleTime}`);
        // Add a small buffer (15 minutes) to account for delays
        return scheduleDatetime >= new Date(currentTime.getTime() - 15 * 60 * 1000);
    } catch (e) {
        return false;
    }
}

// Function to fetch a single page of flight data
async function fetchPage(url, headers, params = null) {
    try {
        const response = await axios({
            method: 'GET',
            url: url,
            params: params,
            headers: headers
        });
        
        if (response.status !== 200) {
            console.error(`Error fetching page: ${response.status}`);
            return { flights: [], hasMore: false, nextUrl: null };
        }
        
        const data = response.data;
        const flights = data.flights || [];
        const nextUrl = getNextPageUrl(response.headers);
        const hasMore = Boolean(nextUrl);
        
        return { flights, hasMore, nextUrl };
    } catch (error) {
        console.error(`Error fetching page: ${error.message}`);
        return { flights: [], hasMore: false, nextUrl: null };
    }
}

// Function to get cache key
function getFlightCacheKey(date, timeWindow, params) {
    if (Object.keys(params).length > 0) {
        // For custom queries, include relevant params in cache key
        const relevantParams = { ...params };
        delete relevantParams.page; // Don't include page in cache key
        return `${date}_${JSON.stringify(relevantParams)}`;
    }
    return `${date}_${timeWindow || 'all'}`;
}

// Function to check if cache is valid
function isFlightCacheValid(cacheEntry) {
    if (!cacheEntry || !cacheEntry.timestamp) return false;
    return (Date.now() - cacheEntry.timestamp) < FLIGHT_CACHE_DURATION;
}

// Netlify function handler
exports.handler = async function(event, context) {
    // Get query parameters from event
    const queryParams = event.queryStringParameters || {};
    
    // Access environment variables
    const appId = process.env.SCHIPHOL_APP_ID;
    const appKey = process.env.SCHIPHOL_APP_KEY;
    
    if (!appId || !appKey) {
        console.error("Schiphol API credentials not found in environment variables.");
        return {
            statusCode: 500,
            body: JSON.stringify({ message: "Server configuration error." })
        };
    }

    // Get current time in Netherlands timezone
    const now = new Date();
    // Convert current time to Amsterdam timezone. Using toLocaleString keeps
    // compatibility without additional dependencies.
    const nlTime = new Date(
        now.toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' })
    );
    
    // Get today's date in YYYY-MM-DD format
    const todayDate = format(nlTime, 'yyyy-MM-dd');
    
    // Use query parameter for time window if provided
    const timeWindow = queryParams.timeWindow;
    const rawQueryParams = { ...queryParams };
    
    // Delete special parameters from rawQueryParams
    delete rawQueryParams.timeWindow;
    delete rawQueryParams.maxPages;
    delete rawQueryParams.useDateTimeRange;

    // Extract special parameters
    const maxPages = parseInt(queryParams.maxPages) || 200;
    const useDateTimeRange = queryParams.useDateTimeRange === 'true';

    // Generate cache key based on date and parameters
    const cacheKey = getFlightCacheKey(todayDate, timeWindow, rawQueryParams);
    
    // Check cache first
    const cachedData = flightDataCache.get(cacheKey);
    if (isFlightCacheValid(cachedData)) {
        console.log(`Using cached flight data for ${cacheKey}`);
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=30'
            },
            body: JSON.stringify({
                ...cachedData.data,
                meta: {
                    ...cachedData.data.meta,
                    cached: true,
                    cacheAge: Math.round((Date.now() - cachedData.timestamp) / 1000),
                    nextUpdate: Math.round((cachedData.timestamp + FLIGHT_CACHE_DURATION - Date.now()) / 1000)
                }
            })
        };
    }

    // Initialize empty API params object
    let apiParams = {};
    
    // Always set flightDirection to 'A' for arrivals at Amsterdam Schiphol
    apiParams.flightDirection = 'A';
    
    // Handle case when using specific query parameters instead of time windows
    if (Object.keys(rawQueryParams).length > 0) {
        apiParams = validateAndCleanParams(rawQueryParams);
    } else {
        // Set parameters based on time window
        const endTime = addHours(nlTime, 24); // Look ahead 24 hours like Python example
        
        // Use proper date-time range like Python example
        apiParams.fromDateTime = format(nlTime, "yyyy-MM-dd'T'HH:mm:ss");
        apiParams.toDateTime = format(endTime, "yyyy-MM-dd'T'HH:mm:ss");
        apiParams.searchDateTimeField = 'scheduleDateTime';
    }
    
    // Add sort parameter if not already set
    if (!apiParams.sort) {
        apiParams.sort = '+scheduleTime';
    }
    
    // Set page to 0 if not specified
    if (apiParams.page === undefined) {
        apiParams.page = 0;
    }
    
    // Build the API URL
    const baseApiUrl = `https://api.schiphol.nl/public-flights/flights`;
    
    try {
        // Setup API headers
        const headers = {
            'Accept': 'application/json',
            'app_id': appId,
            'app_key': appKey,
            'ResourceVersion': 'v4',
        };
        
        // Initialize tracking variables
        let allFlights = [];
        let pageCount = 0;
        let totalFlightsSeen = 0;
        let currentUrl = baseApiUrl;
        let currentParams = apiParams;
        let hasMore = true;
        let pastFlightPagesCount = 0;
        const MAX_PAST_PAGES = 3; // Stop after seeing too many pages with only past flights
        
        // Estimate starting page based on time of day
        const estimatedStartPage = estimateStartingPage(nlTime);
        if (estimatedStartPage > 0) {
            currentParams.page = estimatedStartPage;
        }
        
        // Fetch pages until no more or reached max pages
        while (hasMore && pageCount < maxPages) {
            const { flights, hasMore: morePages, nextUrl } = 
                pageCount === 0 
                    ? await fetchPage(currentUrl, headers, currentParams)
                    : await fetchPage(currentUrl, headers);
                
            if (!flights || flights.length === 0) {
                break;
            }
            
            // Filter flights that are in the future
            const futureFlights = flights.filter(flight => isFlightInFuture(flight, nlTime));
            
            // If this page has no future flights, increment counter
            if (futureFlights.length === 0) {
                pastFlightPagesCount++;
                // If we've seen too many pages with only past flights, stop
                if (pastFlightPagesCount >= MAX_PAST_PAGES) {
                    console.log(`Stopping after ${pastFlightPagesCount} pages with no future flights`);
                    break;
                }
            } else {
                // Reset counter if we found future flights
                pastFlightPagesCount = 0;
            }

            totalFlightsSeen += flights.length;
            allFlights = [...allFlights, ...futureFlights];
            
            // Break if no more pages or reached max pages
            if (!morePages) {
                hasMore = false;
                break;
            }
            
            if (pageCount >= maxPages - 1) {
                hasMore = morePages;
                break;
            }
            
            pageCount++;
            currentUrl = nextUrl;
            currentParams = null;
        }
        
        console.log(`Retrieved ${allFlights.length} future flights from ${pageCount + 1} pages (started from page ${estimatedStartPage})`);

        // Process flights to enhance route information
        allFlights = await processFlightData(allFlights);
        
        // Sort by scheduled time
        allFlights.sort((a, b) => {
            if (!a.scheduleTime) return 1;
            if (!b.scheduleTime) return -1;
            return a.scheduleTime.localeCompare(b.scheduleTime);
        });
        
        // Prepare response data
        const response = {
            flights: allFlights,
            timeInfo: {
                queryTime: nlTime.toISOString(),
                targetDate: apiParams.scheduleDate || apiParams.fromDateTime?.split('T')[0],
                timeWindow,
                windowDetails: TIME_WINDOWS[timeWindow]
            },
            meta: {
                totalFlights: allFlights.length,
                pagesRetrieved: pageCount + 1,
                hasMorePages: hasMore,
                cached: false,
                availableTimeWindows: Object.entries(TIME_WINDOWS).map(([key, value]) => ({
                    id: key,
                    displayName: value.displayName,
                    description: value.description
                }))
            }
        };

        // Cache the response
        flightDataCache.set(cacheKey, {
            data: response,
            timestamp: Date.now()
        });

        // Clean up old cache entries
        for (const [key, value] of flightDataCache.entries()) {
            if (!isFlightCacheValid(value)) {
                flightDataCache.delete(key);
            }
        }

        // Return successful response
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=30'
            },
            body: JSON.stringify(response)
        };

    } catch (error) {
        console.error("Error in serverless function:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ 
                message: "Internal Server Error.",
                error: error.message,
                flights: [] // Return empty data for graceful failure
            })
        };
    }
} 