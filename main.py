import os
import sys
import requests
import json
import argparse
from langgraph.graph import StateGraph, END
from typing import List, Dict, Any, TypedDict, Optional, Union

# Import for Gemini LLM integration
import google.generativeai as genai

class Hotel(TypedDict):
    name: str
    score: float
    source: str
    address: Optional[str]
    rating: Optional[str]
    reviews: List[Dict[str, Any]]
    llm_analysis: Optional[Dict[str, Any]]

class HotelContext(TypedDict, total=False):
    location: str
    checkin: str
    checkout: str
    guests: int
    keywords: List[str]
    google_data: Dict[str, Any]
    combined_hotels: Dict[str, Any]
    top_hotels: List[Hotel]

# ========== CONFIGURATION ==========
MCP_BASE_URL = "http://localhost:3002"

# Gemini API configuration
GEMINI_API_KEY = "AIzaSyCNZH3YYWO5c7v4k-3qH5LNqv2fZsQlNMo"

# Configure Gemini API
genai.configure(api_key=GEMINI_API_KEY)

# Define the model name (use the standard gemini-pro model which is widely available)
GEMINI_MODEL = "gemini-2.0-flash"
gemini_model = genai.GenerativeModel(model_name=GEMINI_MODEL)

# Define a function to analyze reviews without relying solely on external APIs
def analyze_reviews_locally(reviews, keywords):
    """Analyze hotel reviews locally without using external APIs."""
    # Initialize scores
    scores = {keyword: 0 for keyword in keywords}
    mentions = {keyword: 0 for keyword in keywords}
    
    # Count keyword mentions in reviews
    for review in reviews:
        review_text = review.get('text', '').lower()
        for keyword in keywords:
            if keyword.lower() in review_text:
                mentions[keyword] += 1
    
    # Calculate scores based on mentions
    for keyword in keywords:
        if mentions[keyword] > 0:
            # Scale from 0-10 based on mentions
            scores[keyword] = min(10.0, 5.0 + (mentions[keyword] * 1.0))
        else:
            scores[keyword] = 5.0  # Neutral score
    
    # Calculate overall score as average of keyword scores
    overall_score = sum(scores.values()) / len(scores) if scores else 5.0
    
    return {
        'overall_score': overall_score,
        'aspect_scores': scores,
        'mentions': mentions
    }

# ========== UTILS ==========
def brightdata_mcp_query(location="New York", checkin="2025-05-01", checkout="2025-05-03", guests=2, keywords=None) -> Dict[str, Any]:
    """
    Query the local Express proxy server at /hotels with query parameters.
    
    Args:
        location: Location to search for hotels
        checkin: Check-in date (YYYY-MM-DD)
        checkout: Check-out date (YYYY-MM-DD)
        guests: Number of guests
        keywords: Optional list of keywords to filter hotel reviews by
        
    Returns:
        JSON response containing hotel data
    """
    params = {
        "location": location,
        "checkin": checkin,
        "checkout": checkout,
        "guests": guests,
    }
    
    # Add keywords parameter if provided
    if keywords and isinstance(keywords, list) and len(keywords) > 0:
        params["keywords"] = ",".join(keywords)
    
    print(f"Looking for hotels in {location} with keywords: {', '.join(keywords) if keywords else 'None'}")
    response = requests.get(f"{MCP_BASE_URL}/hotels", params=params)
    response.raise_for_status()
    return response.json()


def fetch_hotel_reviews(hotel_name, location, booking_url=None, keywords=None) -> Dict[str, Any]:
    """
    Query the local Express proxy server at /hotel-reviews to get detailed reviews for a specific hotel.
    
    This uses Google Travel URLs to fetch more detailed and recent reviews for a hotel.
    
    Args:
        hotel_name: Name of the hotel to fetch reviews for
        location: Location of the hotel
        booking_url: Optional direct Booking.com URL to fetch reviews from
        keywords: Optional list of keywords to filter hotel reviews by
        
    Returns:
        JSON response containing detailed hotel reviews
    """
    params = {
        "hotelName": hotel_name,
        "location": location,
    }
    
    # Add booking_url parameter if provided
    if booking_url:
        params["bookingUrl"] = booking_url
    
    # Add keywords parameter if provided
    if keywords and isinstance(keywords, list) and len(keywords) > 0:
        params["keywords"] = ",".join(keywords)
    
    try:
        print(f"Fetching detailed reviews for {hotel_name} in {location}...")
        response = requests.get(f"{MCP_BASE_URL}/hotel-reviews", params=params)
        response.raise_for_status()
        result = response.json()
        
        review_count = len(result.get("results", {}).get("reviews", []))
        print(f"Found {review_count} detailed reviews for {hotel_name}")
        
        return result
    except Exception as e:
        print(f"Error fetching hotel reviews: {e}")
        return {"error": str(e), "results": {"reviews": []}}


def analyze_hotel_reviews(hotel_name: str, reviews: List[Dict[str, Any]], keywords: List[str]) -> Dict[str, Any]:
    """
    Analyze hotel reviews using Gemini Pro to generate scores and insights.
    
    Args:
        hotel_name: Name of the hotel being analyzed
        reviews: List of review objects containing text and other metadata
        keywords: List of keywords to focus on in the analysis
        
    Returns:
        Dictionary containing scores and analysis
    """
    # If no reviews are available, return default values
    if not reviews:
        print(f"No reviews available for {hotel_name}. Skipping analysis.")
        return {
            "overall_score": 0.0,
            "aspect_scores": {},
            "summary": "No reviews available for analysis.",
            "strengths": [],
            "weaknesses": []
        }
    
    # If we have very few reviews, use a simpler approach without Gemini
    if len(reviews) < 2:
        print(f"Only {len(reviews)} reviews available for {hotel_name}. Using simplified analysis.")
        return analyze_reviews_with_local_method(hotel_name, reviews, keywords)
    
    # For hotels with sufficient reviews, try using Gemini first
    try:
        print(f"Analyzing {len(reviews)} reviews for {hotel_name} with Gemini Pro...")
        gemini_analysis = analyze_reviews_with_gemini(hotel_name, reviews, keywords)
        return gemini_analysis
    except Exception as e:
        print(f"Error using Gemini for {hotel_name}: {e}. Falling back to local analysis.")
        return analyze_reviews_with_local_method(hotel_name, reviews, keywords)


def analyze_reviews_with_gemini(hotel_name: str, reviews: List[Dict[str, Any]], keywords: List[str]) -> Dict[str, Any]:
    """Analyze hotel reviews using Gemini Pro."""
    # Prepare review texts for Gemini
    review_texts = []
    for i, review in enumerate(reviews[:10]):  # Limit to 10 reviews to avoid token limits
        review_text = review.get('text', '')
        if review_text:
            rating = review.get('rating', 'N/A')
            review_texts.append(f"Review {i+1} (Rating: {rating}): {review_text}")
    
    # Join reviews into a single string
    reviews_content = "\n\n".join(review_texts)
    
    # Create a prompt for Gemini
    prompt = f"""You are a hotel review analyst. Analyze these reviews for '{hotel_name}' and provide scores and insights.

Focus on these aspects: {', '.join(keywords)}

Reviews:
{reviews_content}

Based on these reviews, please provide:
1. An overall score from 0.0 to 10.0
2. Individual scores for each aspect (0.0 to 10.0)
3. A brief summary of the hotel's quality (2-3 sentences)
4. Top 3 strengths
5. Top 3 weaknesses or areas for improvement

Format your response as a JSON object with these keys: 'overall_score', 'aspect_scores', 'summary', 'strengths', 'weaknesses'.
"""
    
    print(f"Sending {len(reviews_content)} characters of review content to Gemini Pro...")
    
    # Set up the model configuration
    generation_config = {
        "temperature": 0.2,
        "top_p": 0.95,
        "top_k": 0,
        "max_output_tokens": 2048,
    }
    
    # Call the Gemini API
    response = gemini_model.generate_content(prompt, generation_config=generation_config)
    
    # Extract and parse the JSON response
    analysis_text = response.text
    
    # Clean up the response if needed (sometimes Gemini adds markdown code blocks)
    if analysis_text.startswith("```json") and analysis_text.endswith("```"):
        analysis_text = analysis_text[7:-3].strip()
    elif analysis_text.startswith("```") and analysis_text.endswith("```"):
        analysis_text = analysis_text[3:-3].strip()
    
    # Parse the JSON response
    analysis = json.loads(analysis_text)
    
    # Validate and ensure all required keys are present
    required_keys = ['overall_score', 'aspect_scores', 'summary', 'strengths', 'weaknesses']
    for key in required_keys:
        if key not in analysis:
            analysis[key] = [] if key in ['strengths', 'weaknesses'] else \
                            {} if key == 'aspect_scores' else \
                            "No data" if key == 'summary' else 5.0
    
    print(f"Gemini Pro analysis complete for {hotel_name}")
    return analysis


def analyze_reviews_with_local_method(hotel_name: str, reviews: List[Dict[str, Any]], keywords: List[str]) -> Dict[str, Any]:
    """Analyze hotel reviews using a local method without external APIs"""
    print(f"Using local method to analyze reviews for {hotel_name}...")
    
    # Initialize the result structure
    result = {
        "overall_score": 0.0,
        "aspect_scores": {},
        "summary": "",
        "strengths": [],
        "weaknesses": []
    }
    
    # If there are no reviews, return a default result
    if not reviews:
        result["summary"] = f"No reviews available for {hotel_name}."
        return result
    
    # Count the number of reviews that mention each keyword
    keyword_mentions = {}
    for keyword in keywords:
        count = sum(1 for r in reviews if keyword.lower() in r.get('text', '').lower())
        if count > 0:
            keyword_mentions[keyword] = count
    
    # Calculate a simple sentiment score based on ratings
    ratings = []
    for review in reviews:
        if review.get('rating'):
            try:
                rating = float(review.get('rating'))
                ratings.append(rating)
            except (ValueError, TypeError):
                pass
    
    # Calculate average rating if available
    avg_rating = sum(ratings) / len(ratings) if ratings else 0.0
    
    # Convert to a 0-10 scale for consistency with Gemini output
    if avg_rating > 0:
        # Assuming ratings are on a 0-5 scale
        overall_score = (avg_rating / 5.0) * 10.0
    else:
        # If no ratings, estimate from positive/negative mentions
        positive_words = ['good', 'great', 'excellent', 'amazing', 'love', 'best', 'perfect', 'wonderful', 'fantastic', 'awesome']
        negative_words = ['bad', 'poor', 'terrible', 'awful', 'worst', 'horrible', 'disappointing', 'disappointed', 'not good', 'not great']
        
        positive_count = 0
        negative_count = 0
        
        for r in reviews:
            text = r.get('text', '').lower()
            if any(pos in text for pos in positive_words):
                positive_count += 1
            if any(neg in text for neg in negative_words):
                negative_count += 1
        
        total = len(reviews)
        if total > 0:
            positive_ratio = positive_count / total
            negative_ratio = negative_count / total
            sentiment_score = (positive_ratio - negative_ratio + 1) / 2  # Scale to 0-1
            overall_score = sentiment_score * 10.0
        else:
            overall_score = 5.0  # Neutral score if no sentiment data
    
    # Generate aspect scores based on keyword mentions
    aspect_scores = {}
    for keyword, count in keyword_mentions.items():
        # Calculate a score based on mention frequency
        mention_ratio = count / len(reviews)
        
        # Check if mentions are positive or negative
        positive_words = ['good', 'great', 'excellent', 'amazing', 'love', 'best', 'perfect', 'wonderful', 'fantastic', 'awesome']
        negative_words = ['bad', 'poor', 'terrible', 'awful', 'worst', 'horrible', 'disappointing', 'disappointed', 'not good', 'not great']
        
        positive_mentions = 0
        negative_mentions = 0
        
        for review in reviews:
            text = review.get('text', '').lower()
            if keyword.lower() in text:
                # Check if the mention is in a positive or negative context
                if any(pos in text for pos in positive_words):
                    positive_mentions += 1
                elif any(neg in text for neg in negative_words):
                    negative_mentions += 1
        
        # Calculate aspect score based on positive vs negative mentions
        if positive_mentions + negative_mentions > 0:
            positive_ratio = positive_mentions / (positive_mentions + negative_mentions)
            aspect_score = positive_ratio * 10.0
        else:
            # If no clear sentiment, use a score slightly above neutral based on mentions
            aspect_score = 5.0 + (mention_ratio * 2.0)  # Ranges from 5.0 to 7.0
        
        aspect_scores[keyword] = round(aspect_score, 1)
    
    # If no aspect scores from keywords, create some basic ones
    if not aspect_scores and reviews:
        aspect_scores = {
            "overall experience": round(overall_score, 1),
            "value": round(max(3.0, min(overall_score - 1.0, 10.0)), 1),
            "location": round(max(3.0, min(overall_score + 0.5, 10.0)), 1)
        }
    
    # Generate strengths and weaknesses based on aspect scores
    strengths = []
    weaknesses = []
    
    for aspect, score in aspect_scores.items():
        mention_text = f" (mentioned in {keyword_mentions.get(aspect, 0)} reviews)" if aspect in keyword_mentions else ""
        
        if score >= 7.0:
            strengths.append(f"Good {aspect.lower()}{mention_text}")
        elif score <= 4.0:
            weaknesses.append(f"Needs improvement in {aspect.lower()}{mention_text}")
    
    # Add at least one strength if none found
    if not strengths and aspect_scores:
        best_aspect = max(aspect_scores.items(), key=lambda x: x[1])
        strengths.append(f"Relatively good {best_aspect[0].lower()} compared to other aspects")
    
    # Generate a summary
    if len(reviews) >= 5:
        summary = f"Based on {len(reviews)} reviews, {hotel_name} has an overall score of {round(overall_score, 1)}/10.0. "
    else:
        summary = f"Based on limited data ({len(reviews)} reviews), {hotel_name} has an estimated score of {round(overall_score, 1)}/10.0. "
    
    if strengths:
        summary += "Positive aspects: " + ", ".join(strengths) + ". "
    
    if weaknesses:
        summary += "Areas for improvement: " + ", ".join(weaknesses) + "."
    
    # Finalize the result
    result["overall_score"] = round(overall_score, 1)
    result["aspect_scores"] = aspect_scores
    result["summary"] = summary
    result["strengths"] = strengths
    result["weaknesses"] = weaknesses
    
    return result

# ========== LANGGRAPH AGENT NODES ==========

def orchestrator(context: Dict[str, Any]) -> Dict[str, Any]:
    print("Orchestrator: Starting hotel recommendation pipeline...")
    # Always explicitly set these keys to guarantee a state update
    context = dict(context)  # Avoid mutating input
    context["location"] = context.get("location", "New York")
    context["checkin"] = context.get("checkin", "2025-05-01")
    context["checkout"] = context.get("checkout", "2025-05-03")
    context["guests"] = context.get("guests", 2)
    context["keywords"] = context.get("keywords", ["breakfast", "clean", "service", "location", "value"])
    
    print(f"Looking for hotels in {context['location']} with keywords: {', '.join(context['keywords'])}")
    
    # Safeguard: ensure at least one required key is set
    required_keys = ["location", "checkin", "checkout", "guests", "keywords", "google_data", "combined_hotels", "top_hotels"]
    if not any(k in context for k in required_keys):
        context["location"] = "Unknown"
    return context


def google_hotel_agent(context: Dict[str, Any]) -> Dict[str, Any]:
    print("Google Hotel Agent: Querying our hotel scraping server with Bright Data MCP API...")
    try:
        # Get parameters from context
        location = context.get("location", "New York")
        checkin = context.get("checkin", "2025-05-01")
        checkout = context.get("checkout", "2025-05-03")
        guests = context.get("guests", 2)
        keywords = context.get("keywords", [])
        
        # Step 1: Query the hotel scraping server to get a list of hotels
        print(f"Step 1: Fetching hotels in {location} from /hotels endpoint...")
        result = brightdata_mcp_query(location, checkin, checkout, guests, keywords)
        
        # Store the initial result in context
        context["google_data"] = result
        
        # Print some information about the results
        hotels = result.get("results", {}).get("hotels", [])
        print(f"Retrieved {len(hotels)} hotels from Google search results")
        
        # Step 2: For each hotel, fetch detailed reviews using the /hotel-reviews endpoint
        print(f"Step 2: Fetching detailed reviews for each hotel from /hotel-reviews endpoint...")
        hotels_with_reviews = []
        
        for i, hotel in enumerate(hotels[:5]):  # Limit to top 5 hotels to avoid too many requests
            hotel_name = hotel.get("name", "")
            if not hotel_name:
                continue
                
            print(f"Processing hotel {i+1}/{min(5, len(hotels))}: {hotel_name}")
            
            # Fetch detailed reviews for this hotel
            detailed_reviews = fetch_hotel_reviews(hotel_name, location, None, keywords)
            
            # Extract the reviews
            reviews = detailed_reviews.get("results", {}).get("reviews", [])
            
            # Add the detailed reviews to the hotel data
            if reviews:
                print(f"Found {len(reviews)} detailed reviews for {hotel_name}")
                hotel["detailed_reviews"] = reviews
                # Combine the original reviews with the detailed reviews
                all_reviews = hotel.get("reviews", []) + reviews
                # Remove duplicates (based on text content)
                seen_texts = set()
                unique_reviews = []
                for review in all_reviews:
                    text = review.get("text", "")
                    if text and text not in seen_texts:
                        seen_texts.add(text)
                        unique_reviews.append(review)
                hotel["reviews"] = unique_reviews
            
            hotels_with_reviews.append(hotel)
        
        # Update the context with the enhanced hotel data
        if hotels_with_reviews:
            result["results"]["hotels"] = hotels_with_reviews
            context["google_data"] = result
        
        # Check if we have reviews and keywords
        if keywords and hotels_with_reviews:
            review_count = 0
            for hotel in hotels_with_reviews:
                reviews = hotel.get("reviews", [])
                review_count += len(reviews)
            print(f"Found a total of {review_count} reviews matching keywords: {', '.join(keywords)}")
    except Exception as e:
        print(f"Error in google_hotel_agent: {e}")
        context["google_data"] = {"error": str(e), "results": {"hotels": []}}
    
    # Safeguard: ensure at least one required key is set
    required_keys = ["location", "checkin", "checkout", "guests", "keywords", "google_data", "combined_hotels", "top_hotels"]
    if not any(k in context for k in required_keys):
        context["location"] = "Unknown"
    return context

def scorer_agent(context: Dict[str, Any]) -> Dict[str, Any]:
    print("Scorer Agent: Scoring and ranking hotels based on Google data and review analysis...")
    try:
        # Get the Google hotel data from the combined hotels
        google_data = context.get("google_data", {})
        hotels_data = google_data.get("results", {}).get("hotels", [])
        keywords = context.get("keywords", [])
        location = context.get("location", "New York")
        
        if not hotels_data:
            print("No hotel data found. Attempting to fetch hotels again...")
            try:
                # Try to fetch hotels directly as a fallback
                checkin = context.get("checkin", "2025-05-01")
                checkout = context.get("checkout", "2025-05-03")
                guests = context.get("guests", 2)
                result = brightdata_mcp_query(location, checkin, checkout, guests, keywords)
                hotels_data = result.get("results", {}).get("hotels", [])
                if hotels_data:
                    print(f"Successfully fetched {len(hotels_data)} hotels as fallback")
                    google_data = result
                    context["google_data"] = result
            except Exception as fetch_error:
                print(f"Fallback hotel fetch failed: {fetch_error}")
                
        # If we still don't have hotel data, use a sample
        if not hotels_data:
            print("No hotel data found. Using sample data.")
            context['top_hotels'] = [
                {
                    'name': 'Sample Hotel 1',
                    'score': 4.5,
                    'source': 'sample',
                    'address': f'123 Main St, {location}',
                    'rating': '4.5',
                    'reviews': [
                        {
                            'text': 'Great hotel with excellent service and amenities.',
                            'rating': '4.5',
                            'date': 'April 2025',
                            'author': 'Sample Reviewer',
                            'source': 'sample_data'
                        }
                    ],
                    'llm_analysis': {
                        'overall_score': 8.5,
                        'aspect_scores': {
                            'breakfast': 8.0,
                            'clean': 9.0,
                            'service': 9.5,
                            'location': 8.0,
                            'value': 8.0
                        },
                        'summary': 'This is a sample hotel with excellent service and amenities.',
                        'strengths': ['Excellent service', 'Clean rooms', 'Good breakfast'],
                        'weaknesses': []
                    }
                }
            ]
            return context
        
        # Process and score each hotel
        scored_hotels = []
        
        for hotel in hotels_data:
            hotel_name = hotel.get('name', 'Unknown Hotel')
            print(f"\nScoring hotel: {hotel_name}")
            
            # Extract reviews - prioritize detailed reviews if available
            detailed_reviews = hotel.get('detailed_reviews', [])
            original_reviews = hotel.get('reviews', [])
            
            # Use detailed reviews if available, otherwise use original reviews
            reviews = detailed_reviews if detailed_reviews else original_reviews
            
            # Skip hotels with no reviews
            if not reviews:
                print(f"No reviews found for {hotel_name}. Skipping.")
                continue
            
            # Analyze the reviews
            review_analysis = analyze_hotel_reviews(hotel_name, reviews, keywords)
            
            # Calculate a final score (1-5 scale) based on the review analysis
            overall_score = review_analysis.get('overall_score', 0.0)
            final_score = round(overall_score / 2, 1)  # Convert from 10-point to 5-point scale
            
            # Create a scored hotel object
            scored_hotel = {
                'name': hotel_name,
                'score': final_score,
                'source': hotel.get('source', 'unknown'),
                'address': hotel.get('address', ''),
                'rating': hotel.get('rating', ''),
                'price': hotel.get('price', ''),  # Include price if available
                'reviews': reviews,
                'review_count': len(reviews),
                'llm_analysis': review_analysis
            }
            
            # Print some information about the analysis
            print(f"Analysis Overall Score: {review_analysis.get('overall_score')}/10.0")
            print(f"Final Score: {scored_hotel['score']}/5.0")
            print(f"Summary: {review_analysis.get('summary')}")
            print(f"Reviews analyzed: {len(reviews)}")
            
            if review_analysis.get('aspect_scores'):
                print("Aspect Scores:")
                for aspect, score in review_analysis.get('aspect_scores', {}).items():
                    print(f"  - {aspect}: {score}/10.0")
            
            scored_hotels.append(scored_hotel)
        
        # Sort hotels by score (highest first)
        scored_hotels.sort(key=lambda x: x['score'], reverse=True)
        
        # Store the top hotels in context
        context['top_hotels'] = scored_hotels
        
        # Print the top hotels
        print("\nTop Hotels:")
        for i, hotel in enumerate(scored_hotels[:5]):
            price_info = f" - Price: {hotel.get('price', 'N/A')}" if hotel.get('price') else ""
            print(f"{i+1}. {hotel['name']} - Score: {hotel['score']}/5.0{price_info} - Reviews: {hotel.get('review_count', 0)}")
        
        # Save the hotel rankings to a file
        save_hotel_rankings_to_file(scored_hotels)
        
    except Exception as e:
        print(f"Error in scorer_agent: {e}")
        import traceback
        traceback.print_exc()
        context['top_hotels'] = []
    
    # Safeguard: ensure at least one required key is set
    required_keys = ["location", "checkin", "checkout", "guests", "keywords", "google_data", "combined_hotels", "top_hotels"]
    if not any(k in context for k in required_keys):
        context["location"] = "Unknown"
    return context


def combiner_agent(context: Dict[str, Any]) -> Dict[str, Any]:
    print("Combiner Agent: Processing Google hotel data...")
    try:
        # Get the Google hotel data
        google_data = context.get("google_data", {})
        
        # Store the combined data in context
        context["combined_hotels"] = {
            "google": google_data,
        }
        
        # Print some information about the combined data
        hotels = google_data.get("results", {}).get("hotels", [])
        print(f"Combined data contains {len(hotels)} hotels from Google search results")
        
        # Check if we have reviews and keywords
        keywords = context.get("keywords", [])
        if keywords and hotels:
            review_count = 0
            for hotel in hotels:
                reviews = hotel.get("reviews", [])
                review_count += len(reviews)
            print(f"Found a total of {review_count} reviews matching keywords: {', '.join(keywords)}")
    except Exception as e:
        print(f"Error in combiner_agent: {e}")
        context["combined_hotels"] = {"error": str(e)}
    
    # Safeguard: ensure at least one required key is set
    required_keys = ["location", "checkin", "checkout", "guests", "keywords", "google_data", "combined_hotels", "top_hotels"]
    if not any(k in context for k in required_keys):
        context["location"] = "Unknown"
    return context


# ========== LANGGRAPH SETUP ==========
graph = StateGraph(state_schema=HotelContext)
graph.add_node("orchestrator", orchestrator)
graph.add_node("google_hotel_agent", google_hotel_agent)
graph.add_node("combiner_agent", combiner_agent)
graph.add_node("scorer_agent", scorer_agent)

graph.add_edge("orchestrator", "google_hotel_agent")
graph.add_edge("google_hotel_agent", "combiner_agent")
graph.add_edge("combiner_agent", "scorer_agent")
graph.add_edge("scorer_agent", END)

graph.set_entry_point("orchestrator")


def save_hotel_rankings_to_file(hotels, filename="hotel_rankings.txt"):
    """Save hotel rankings to a file for easier viewing"""
    with open(filename, "w") as f:
        f.write("HOTEL RANKINGS WITH DETAILED ANALYSIS\n")
        f.write("=" * 80 + "\n\n")
        
        for i, hotel in enumerate(hotels):
            review_count = len(hotel.get('reviews', []))
            review_sources = {}
            for r in hotel.get('reviews', []):
                source = r.get('source', 'unknown')
                review_sources[source] = review_sources.get(source, 0) + 1
            
            analysis = hotel.get('llm_analysis', {})
            
            f.write(f"{i+1}. {hotel['name']}\n")
            f.write(f"   Score: {hotel['score']}/5.0\n")
            f.write(f"   Address: {hotel.get('address', 'N/A')}\n")
            f.write(f"   Rating: {hotel.get('rating', 'N/A')}\n")
            if hotel.get('price'):
                f.write(f"   Price: {hotel.get('price')}\n")
            
            # Write review source breakdown
            f.write(f"   Reviews: {review_count} total")
            if review_sources:
                f.write(" (")
                source_strings = [f"{count} from {source}" for source, count in review_sources.items()]
                f.write(", ".join(source_strings))
                f.write(")")
            f.write("\n\n")
            
            # Write analysis details
            if analysis:
                f.write("ANALYSIS:\n")
                f.write(f"Overall Score: {analysis.get('overall_score', 0.0)}/10.0\n")
                f.write(f"Summary: {analysis.get('summary', 'No summary available')}\n\n")
                
                if analysis.get('aspect_scores'):
                    f.write("Aspect Scores:\n")
                    for aspect, score in analysis.get('aspect_scores', {}).items():
                        f.write(f"- {aspect}: {score}/10.0\n")
                    f.write("\n")
                
                if analysis.get('strengths'):
                    f.write("Strengths:\n")
                    for strength in analysis.get('strengths', []):
                        f.write(f"+ {strength}\n")
                    f.write("\n")
                
                if analysis.get('weaknesses'):
                    f.write("Weaknesses:\n")
                    for weakness in analysis.get('weaknesses', []):
                        f.write(f"- {weakness}\n")
                    f.write("\n")
            
            # Write sample reviews
            if hotel.get('reviews'):
                f.write("\nSAMPLE REVIEWS:\n")
                for i, review in enumerate(hotel.get('reviews', [])[:5]):  # Show up to 5 reviews
                    source_info = f" (Source: {review.get('source', 'unknown')})" if review.get('source') else ""
                    f.write(f"Review {i+1}{source_info}: \"{review.get('text', 'No review text')}\"\n")
                    
                    # Add rating if available
                    if review.get('rating'):
                        f.write(f"Rating: {review.get('rating')}\n")
                        
                    # Add author and date if available
                    if review.get('author'):
                        f.write(f"- {review.get('author')}")
                        if review.get('date'):
                            f.write(f" ({review.get('date')})")
                        f.write("\n")
                    f.write("\n")
            
            f.write("=" * 80 + "\n\n")
    
    print(f"Hotel rankings saved to {filename}")
    return filename


if __name__ == "__main__":
    # Parse command-line arguments
    parser = argparse.ArgumentParser(description='Hotel Recommendation System with Gemini Pro')
    parser.add_argument('--location', '-l', type=str, default="New York", help='Location to search for hotels')
    parser.add_argument('--keywords', '-k', type=str, default="breakfast,clean,service,location,value", 
                        help='Comma-separated list of keywords to filter reviews by')
    parser.add_argument('--checkin', '-ci', type=str, default="2025-05-01", help='Check-in date (YYYY-MM-DD)')
    parser.add_argument('--checkout', '-co', type=str, default="2025-05-03", help='Check-out date (YYYY-MM-DD)')
    parser.add_argument('--guests', '-g', type=int, default=2, help='Number of guests')
    parser.add_argument('--output', '-o', type=str, default="hotel_rankings.txt", help='Output file for detailed rankings')
    parser.add_argument('--booking-url', '-b', type=str, help='Direct Booking.com URL to fetch reviews from')
    
    args = parser.parse_args()
    
    # Parse keywords
    keywords = [k.strip() for k in args.keywords.split(',') if k.strip()]
    
    # Compile and run the graph (LangGraph 0.2.x+)
    compiled_graph = graph.compile()
    
    # Initial context with location and review keywords
    context = {
        "location": args.location,
        "checkin": args.checkin,
        "checkout": args.checkout,
        "guests": args.guests,
        "keywords": keywords,
        "booking_url": args.booking_url
    }
    
    print(f"\nSearching for hotels in {args.location} with keywords: {', '.join(keywords)}")
    
    # Invoke the graph with our context
    result = compiled_graph.invoke(context)
    
    # Save detailed rankings to file
    output_file = save_hotel_rankings_to_file(result.get('top_hotels', []), args.output)
    
    # Print a simplified summary to the console
    print("\n" + "="*80)
    print("HOTEL RANKINGS SUMMARY")
    print("="*80)
    
    for i, hotel in enumerate(result.get('top_hotels', [])):
        analysis = hotel.get('llm_analysis', {})
        print(f"\n{i+1}. {hotel['name']}")
        print(f"   Score: {hotel['score']}/5.0")
        print(f"   Rating: {hotel.get('rating', 'N/A')}/5.0")
        
        # Print a brief summary
        if analysis.get('summary'):
            print(f"   Summary: {analysis.get('summary')[:100]}...")
        
        # Print top strength if available
        if analysis.get('strengths') and len(analysis.get('strengths')) > 0:
            print(f"   Top strength: {analysis.get('strengths')[0]}")
    
    print(f"\nDetailed rankings saved to {output_file}")
    print("="*80)
