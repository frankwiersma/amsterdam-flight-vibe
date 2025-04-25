import json
import datetime
import pandas as pd
from tabulate import tabulate
import requests
import pytz  # For timezone handling
from urllib.parse import urlencode, urlparse, parse_qs  # For URL handling

# Function to get country flag emoji from country code
def get_flag_emoji(country_code):
    if not country_code:
        return ""
    
    # Convert country code to uppercase if not already
    code = country_code.upper()
    
    # Calculate the unicode codepoints for the regional indicator symbols
    return chr(ord('🇦') + ord(code[0]) - ord('A')) + chr(ord('🇦') + ord(code[1]) - ord('A'))

# Dictionary of IATA airport codes to cities and countries
airport_info = {
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
}

def get_next_page_url(response):
    """Extract the next page URL from the Link header"""
    if 'Link' not in response.headers:
        return None
        
    # Split on commas and strip whitespace
    links = [link.strip() for link in response.headers['Link'].split(',')]
    
    for link in links:
        # Look for the "next" relation
        if 'rel="next"' in link:
            # Extract URL between < and >
            url_start = link.find('<') + 1
            url_end = link.find('>')
            if url_start > 0 and url_end > 0:
                next_url = link[url_start:url_end]
                # Replace protocol://server_address:port with actual domain
                if 'protocol://' in next_url:
                    next_url = next_url.replace('protocol://server_address:port', 'https://api.schiphol.nl')
                elif next_url.startswith('/'):
                    next_url = f"https://api.schiphol.nl{next_url}"
                return next_url
    
    return None

def fetch_page(url, headers):
    """Fetch a single page of flight data"""
    try:
        response = requests.get(url, headers=headers)
        
        if response.status_code != 200:
            return None, False, None
            
        data = response.json()
        flights = data.get('flights', [])
        
        # Check for Link header to see if there are more pages
        next_url = get_next_page_url(response)
        has_more = bool(next_url)
        
        return flights, has_more, next_url
        
    except Exception as e:
        return None, False, None

def main():
    # Get current time in Netherlands timezone
    nl_timezone = pytz.timezone('Europe/Amsterdam')
    current_time = datetime.datetime.now(nl_timezone)
    end_time = current_time + datetime.timedelta(hours=24)
    
    # Format times for API request
    current_time_str = current_time.strftime("%Y-%m-%dT%H:%M:%S")
    end_time_str = end_time.strftime("%Y-%m-%dT%H:%M:%S")
    
    # Define initial URL with parameters
    params = {
        "fromDateTime": current_time_str,
        "toDateTime": end_time_str,
        "searchDateTimeField": "scheduleDateTime",
        "sort": "+scheduleTime",
        "page": "0",  # Start with page 0
        "flightDirection": "A"  # Only arrivals
    }
    
    base_url = "https://api.schiphol.nl/public-flights/flights"
    url = f"{base_url}?{urlencode(params)}"
    
    # Define request headers exactly as shown in documentation
    headers = {
        "Accept": "application/json",
        "ResourceVersion": "v4",
        "app_id": "db24436c",
        "app_key": "14d969ef174fd67ff4f26d62f120c204"
    }
    
    try:
        # Container for all processed flights
        processed_flights = []
        page_count = 0
        max_pages = 100  # Limit number of pages to fetch
        current_url = url
        
        while True:
            # Fetch current page
            flights, has_more, next_url = fetch_page(current_url, headers)
            
            if not flights:
                break
            
            # Process flight data
            for flight in flights:
                # Flight state filtering - only include expected (SCH/EXP) or delayed (DEL) flights
                flight_states = flight.get('publicFlightState', {}).get('flightStates', [])
                
                # Skip landed (ARR/LND) and cancelled (CNX) flights
                if any(state in flight_states for state in ['LND', 'ARR', 'CNX']):
                    continue
                    
                # Only include expected or delayed flights
                if not (set(flight_states) & set(['SCH', 'DEL', 'EXP']) or 'DEL' in flight_states):
                    continue
                
                # Get schedule date and time
                schedule_date = flight.get('scheduleDate', '')
                schedule_time = flight.get('scheduleTime', '')
                
                # Create a datetime object from the schedule date and time
                if schedule_date and schedule_time:
                    try:
                        # Parse the date and time
                        schedule_datetime_str = f"{schedule_date}T{schedule_time}"
                        schedule_datetime = datetime.datetime.strptime(schedule_datetime_str, "%Y-%m-%dT%H:%M:%S")
                        
                        # Make it timezone aware
                        schedule_datetime = nl_timezone.localize(schedule_datetime)
                        
                        # Skip flights in the past
                        if schedule_datetime < current_time:
                            continue
                            
                    except (ValueError, TypeError):
                        # If we can't parse the date/time, just continue with next flight
                        continue
                
                # Get destination information
                destinations = flight.get('route', {}).get('destinations', [])
                destination = destinations[0] if destinations else "Unknown"
                
                # Get flight status
                status = "Delayed" if "DEL" in flight_states else "Expected"
                
                # Get city and country from airport code
                city = airport_info.get(destination, {}).get('city', destination)
                country_code = airport_info.get(destination, {}).get('country', '')
                flag = get_flag_emoji(country_code)
                
                # Format date (YYYY-MM-DD to DD-MM-YYYY)
                if schedule_date:
                    try:
                        # Parse the date and subtract one day
                        date_obj = datetime.datetime.strptime(schedule_date, "%Y-%m-%d")
                        adjusted_date_obj = date_obj - datetime.timedelta(days=1)
                        formatted_date = adjusted_date_obj.strftime("%d-%m-%Y")
                    except ValueError:
                        formatted_date = schedule_date
                else:
                    formatted_date = ""
                    
                # Format time (HH:MM:SS to HH:MM)
                scheduled_time_formatted = schedule_time[:5] if schedule_time else ''
                
                # Get flight number and airline information
                flight_number = f"{flight.get('prefixIATA', '')}{flight.get('flightNumber', '')}"
                
                # Create a processed flight entry
                processed_flight = {
                    'Flight': flight_number,
                    'Date': formatted_date,
                    'Time (CET)': scheduled_time_formatted,
                    'Destination': destination,
                    'City': city,
                    'Flag': flag,
                    'Status': status,
                    'Gate': flight.get('gate', '')
                }
                
                processed_flights.append(processed_flight)
            
            # Break if no more pages or reached max pages
            if not has_more:
                break
                
            if page_count >= max_pages - 1:
                break
                
            page_count += 1
            current_url = next_url
        
        if not processed_flights:
            print("No upcoming expected or delayed flights found.")
            return
        
        # Sort by scheduled time
        processed_flights.sort(key=lambda x: x['Time (CET)'])
        
        # Filter out flights from before the current time
        current_time_str_hhmm = current_time.strftime("%H:%M")
        future_flights = [flight for flight in processed_flights if flight['Time (CET)'] >= current_time_str_hhmm]
        
        # Create a DataFrame for tabulate
        df = pd.DataFrame(future_flights)
        
        # Get current date and time for display
        now = datetime.datetime.now(nl_timezone)
        current_date_str = now.strftime("%d-%m-%Y")
        current_time_str = now.strftime("%H:%M")
        
        # Display the table with header showing current date and time
        print(f"\nCurrent time: {current_time_str} (Netherlands Time)")
        print(tabulate(df, headers='keys', tablefmt='pretty', showindex=False))
            
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    main() 