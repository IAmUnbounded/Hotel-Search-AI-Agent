// Express server for Bright Data MCP hotel search
import express from 'express';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;
app.use(express.json());

// Bright Data API token
const BRIGHTDATA_MCP_API_TOKEN = '65203a28ae2e955d6fdda4280abc4659183f54bbee41a62632b2f9f60e3627e0';

if (!BRIGHTDATA_MCP_API_TOKEN) {
  console.error('Missing BRIGHTDATA_MCP_API_TOKEN in environment');
  process.exit(1);
}

// Enable detailed logging
const DEBUG = true;

// Helper function for logging
function log(message, data) {
  if (DEBUG) {
    console.log(message);
    if (data) {
      console.log(typeof data === 'object' ? JSON.stringify(data, null, 2).substring(0, 500) + '...' : data);
    }
  }
}

// Helper function to build Google Travel URL for hotel reviews
function build_travel_url(hotelName, location) {
  // Encode the hotel name and location for the URL
  const query = encodeURIComponent(`${hotelName} ${location}`);
  // Create a Google Travel search URL with the reviews tab active
  return `https://www.google.com/travel/search?q=${query}&hl=en&gl=us&ssta=1&ap=ugEHcmV2aWV3cw`;
}

// Proxy endpoint to MCP API
app.post('/v1/scrape', async (req, res) => {
  try {
    const response = await axios.post('http://localhost:8080/v1/scrape', req.body, {
      headers: { 'Authorization': `Bearer ${BRIGHTDATA_MCP_API_TOKEN}` }
    });
    log('Scrape response:', response.data);
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Hotel reviews endpoint - fetches reviews from both Google Travel and Booking.com
app.get('/hotel-reviews', async (req, res) => {
  const { hotelName, location, bookingUrl, keywords } = req.query;
  
  if (!hotelName || !location) {
    return res.status(400).json({ error: 'Missing hotelName or location parameter' });
  }
  
  // Parse keywords for review filtering
  const reviewKeywords = keywords ? keywords.split(',').map(k => k.trim().toLowerCase()) : [];
  
  try {
    log(`Fetching reviews for hotel: ${hotelName} in ${location}`);
    
    // Array to store all reviews from different sources
    let allReviews = [];
    let hotelDetails = {
      name: hotelName,
      location: location,
      rating: '',
      sources: []
    };
    
    // 1. Fetch reviews from Google Travel
    try {
      log('Fetching reviews from Google Travel...');
      // Build the Google Travel URL for hotel reviews
      const travelUrl = build_travel_url(hotelName, location);
      log(`Using Google Travel URL: ${travelUrl}`);
      
      // Make request to Bright Data API for Google Travel
      const googleResponse = await axios({
        url: 'https://api.brightdata.com/request',
        method: 'POST',
        data: {
          url: travelUrl,
          zone: 'serp_api1',
          format: 'json'
        },
        headers: api_headers(),
        responseType: 'json',
      });
      
      log('Received response from Bright Data API for Google Travel reviews');
      
      // Process the response data
      const rawData = googleResponse.data;
      let googleReviews = [];
      
      // Try to extract reviews from the response
      if (rawData && rawData.body && typeof rawData.body === 'string') {
        try {
          // First try to parse as JSON
          if (rawData.body.trim().startsWith('{') || rawData.body.trim().startsWith('[')) {
            log('Attempting to parse Google Travel response body as JSON');
            const parsedBody = JSON.parse(rawData.body);
            
            // Look for reviews in the parsed data
            if (parsedBody.reviews && Array.isArray(parsedBody.reviews)) {
              log(`Found ${parsedBody.reviews.length} reviews in Google Travel parsed body`);
              googleReviews = parsedBody.reviews.map(review => ({
                text: review.text || review.snippet || '',
                rating: review.rating || '',
                date: review.date || '',
                author: review.author || '',
                source: 'google_travel'
              }));
            }
          } 
          // If it's not JSON, it's likely HTML
          else if (rawData.body.includes('<!doctype html>') || rawData.body.includes('<html')) {
            log('Google Travel response body appears to be HTML, extracting reviews directly');
            
            // Extract reviews from Google Travel HTML
            // Look for review blocks in the HTML
            const reviewBlocks = rawData.body.match(/<div[^>]*data-review-id[^>]*>[\s\S]*?<div[^>]*>([0-9]\.[0-9]|[0-9]) out of [0-9][\s\S]*?<div[^>]*>([^<]+)<\/div>[\s\S]*?<\/div>/g) || [];
            log(`Found ${reviewBlocks.length} review blocks in Google Travel HTML`);
            
            // Extract information from each review block
            reviewBlocks.forEach((block, index) => {
              // Extract rating
              const ratingMatch = block.match(/([0-9]\.[0-9]|[0-9]) out of [0-9]/);
              const rating = ratingMatch ? ratingMatch[1] : '';
              
              // Extract review text
              const textMatch = block.match(/<div[^>]*>([^<]{10,})<\/div>/);
              const text = textMatch ? textMatch[1].trim() : '';
              
              // Extract date if available
              const dateMatch = block.match(/<span[^>]*>([A-Za-z]+ [0-9]{4})<\/span>/);
              const date = dateMatch ? dateMatch[1] : '';
              
              // Extract author if available
              const authorMatch = block.match(/<span[^>]*>([^<]+)<\/span>[\s\S]*?<span[^>]*>([A-Za-z]+ [0-9]{4})<\/span>/);
              const author = authorMatch ? authorMatch[1].trim() : '';
              
              if (text && text.length > 10) {
                googleReviews.push({
                  text: text,
                  rating: rating,
                  date: date,
                  author: author,
                  source: 'google_travel_html'
                });
              }
            });
            
            // If we couldn't find reviews in the standard way, try an alternative approach
            if (googleReviews.length === 0) {
              // Look for any text that might be a review
              const potentialReviews = rawData.body.match(/<span[^>]*>([^<]{50,})<\/span>/g) || [];
              
              potentialReviews.forEach(reviewMatch => {
                const reviewText = reviewMatch.replace(/<[^>]+>/g, '').trim();
                if (reviewText && 
                    reviewText.length > 50 && 
                    !reviewText.includes('http') && 
                    !googleReviews.some(r => r.text === reviewText)) {
                  googleReviews.push({
                    text: reviewText,
                    source: 'google_travel_extracted'
                  });
                }
              });
            }
          }
        } catch (e) {
          log('Error processing Google Travel response body:', e.message);
        }
      }
      
      if (googleReviews.length > 0) {
        log(`Found ${googleReviews.length} reviews from Google Travel`);
        allReviews = [...allReviews, ...googleReviews];
        hotelDetails.sources.push('google_travel');
      }
    } catch (googleErr) {
      log('Error fetching Google Travel reviews:', googleErr.message);
    }
    
    // 2. Fetch reviews from Booking.com
    try {
      log('Fetching reviews from Booking.com...');
      // Determine the Booking.com URL to scrape
      let targetUrl;
      if (bookingUrl) {
        // If a direct Booking.com URL is provided, use it
        targetUrl = bookingUrl;
        if (!targetUrl.includes('#tab-reviews')) {
          // Ensure we're looking at the reviews tab
          targetUrl = targetUrl.includes('?') ? `${targetUrl}&tab=reviews` : `${targetUrl}?tab=reviews`;
        }
      } else {
        // Otherwise build a search URL from hotel name and location
        targetUrl = build_booking_url(hotelName, location);
      }
      
      log(`Using Booking.com URL: ${targetUrl}`);
      
      // Make request to Bright Data API for Booking.com
      const bookingResponse = await axios({
        url: 'https://api.brightdata.com/request',
        method: 'POST',
        data: {
          url: targetUrl,
          zone: 'serp_api1',
          format: 'json'
        },
        headers: api_headers(),
        responseType: 'json',
      });
      
      log('Received response from Bright Data API');
      
      // Process the response data
      const rawData = bookingResponse.data;
      
      // Check if the response body is HTML
      if (rawData && rawData.body && (rawData.body.includes('<!doctype html>') || rawData.body.includes('<html'))) {
          log('Response body is HTML, extracting Booking.com reviews');
          
          // Extract hotel name if available
          const hotelNameMatch = rawData.body.match(/<h2[^>]*>([^<]+)<\/h2>/);
          if (hotelNameMatch && hotelNameMatch[1]) {
            hotelDetails.name = hotelNameMatch[1].trim();
          }
          
          // Extract hotel rating if available
          const ratingMatch = rawData.body.match(/"ratingValue":"([0-9]\.[0-9])"/); 
          if (ratingMatch && ratingMatch[1]) {
            hotelDetails.rating = ratingMatch[1];
          }
          
          // Extract review blocks from Booking.com HTML
          // This is a simplified approach - in production, you would use a more robust HTML parser
          const reviewBlocks = rawData.body.match(/<div[^>]*review_list_new_item_block[^>]*>[\s\S]*?<\/div>[\s\S]*?<\/div>[\s\S]*?<\/div>/g) || [];
          log(`Found ${reviewBlocks.length} review blocks in Booking.com HTML`);
          
          // Extract information from each review block
          reviewBlocks.forEach((block, index) => {
            // Extract review score
            const scoreMatch = block.match(/<div[^>]*bui-review-score__badge[^>]*>([0-9]\.[0-9]|[0-9])<\/div>/);
            const score = scoreMatch ? scoreMatch[1] : '';
            
            // Extract review title
            const titleMatch = block.match(/<h3[^>]*>([^<]+)<\/h3>/);
            const title = titleMatch ? titleMatch[1].trim() : '';
            
            // Extract review text
            const textMatch = block.match(/<span[^>]*review_item_text[^>]*>([^<]+)<\/span>/);
            let text = textMatch ? textMatch[1].trim() : '';
            
            // Combine title and text if both exist
            if (title && text) {
              text = `${title}: ${text}`;
            } else if (title) {
              text = title;
            }
            
            // Extract date if available
            const dateMatch = block.match(/<span[^>]*review_item_date[^>]*>([^<]+)<\/span>/);
            const date = dateMatch ? dateMatch[1].trim() : '';
            
            // Extract author if available
            const authorMatch = block.match(/<span[^>]*bui-avatar-block__title[^>]*>([^<]+)<\/span>/);
            const author = authorMatch ? authorMatch[1].trim() : '';
            
            if (text && text.length > 5) {
              reviews.push({
                text: text,
                rating: score,
                date: date,
                author: author,
                source: 'booking_com'
              });
            }
          });
          
          // If we couldn't find reviews in the standard way, try an alternative approach
          if (reviews.length === 0) {
            // Look for any review text
            const reviewTexts = rawData.body.match(/<p[^>]*review_item_text[^>]*>([\s\S]*?)<\/p>/g) || [];
            
            reviewTexts.forEach(reviewHtml => {
              const reviewText = reviewHtml.replace(/<[^>]+>/g, '').trim();
              if (reviewText && reviewText.length > 10) {
                reviews.push({
                  text: reviewText,
                  source: 'booking_com_alt'
                });
              }
            });
          }
          
          // If we're on a search results page, try to find the direct hotel URL
          if (reviews.length === 0 && targetUrl.includes('searchresults')) {
            const hotelLinkMatch = rawData.body.match(/href="(\/hotel\/[^"]+)"/);
            if (hotelLinkMatch && hotelLinkMatch[1]) {
              const hotelPath = hotelLinkMatch[1];
              const hotelUrl = `https://www.booking.com${hotelPath}`;
              
              log(`Found hotel URL: ${hotelUrl}, will redirect to get reviews`);
              
              // Return a response indicating we need to redirect
              return res.json({
                success: true,
                redirect: true,
                message: 'Found hotel URL, redirect to get reviews',
                hotelUrl: hotelUrl,
                query: { hotelName, location, keywords }
              });
            }
          }
        }
      }catch (e) {
      log('Error processing Booking.com response:', e.message);
    }
    
    // Filter reviews by keywords if provided
    let filteredReviews = reviews;
    if (reviewKeywords.length > 0 && reviews.length > 0) {
      filteredReviews = reviews.filter(review => {
        const reviewText = review.text.toLowerCase();
        return reviewKeywords.some(keyword => reviewText.includes(keyword));
      });
      
      // If no reviews match the keywords, include a note
      if (filteredReviews.length === 0) {
        filteredReviews = [{
          text: `No reviews matching keywords: ${reviewKeywords.join(', ')}`,
          source: 'system_message'
        }];
      }
    }
    
    // If we still don't have reviews, create a mock response for debugging
    if (filteredReviews.length === 0) {
      log('No Booking.com reviews found, creating sample data for debugging');
      
      filteredReviews = [
        {
          text: 'This is a sample Booking.com review for debugging purposes. The hotel had great service and clean rooms.',
          rating: '8.5',
          date: 'April 2025',
          author: 'Sample Booking.com Reviewer',
          source: 'booking_com_sample'
        }
      ];
    }
    
    // Create a well-structured response
    const formattedResponse = {
      success: true,
      query: {
        hotelName: hotelDetails.name,
        location,
        bookingUrl: targetUrl,
        keywords: reviewKeywords.length > 0 ? reviewKeywords : 'not specified'
      },
      hotelDetails,
      results: {
        reviews: filteredReviews,
        totalReviews: filteredReviews.length
      }
    };
    
    log(`Returning ${filteredReviews.length} Booking.com reviews for ${hotelDetails.name}`);
    res.json(formattedResponse);
  } catch (err) {
    // Enhanced error handling
    log('Error fetching Booking.com reviews:', err.message);
    if (err.response && err.response.data) {
      log('API Error details:', err.response.data);
    }
    
    // Return a detailed error response
    res.status(500).json({ 
      success: false, 
      error: err.message || 'Booking.com review scraping failed',
      query: { hotelName, location, bookingUrl, keywords },
      details: err.response && err.response.data ? err.response.data : {}
    });
  }
});

app.listen(port, () => {
  console.log(`Express proxy server running on port ${port}`);
});

// Helper to build API headers
function api_headers() {
  return {
    'Authorization': `Bearer ${BRIGHTDATA_MCP_API_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

// Hotel scraping endpoint
app.get('/hotels', async (req, res) => {
  const { location, checkin, checkout, guests, keywords } = req.query;
  if (!location) {
    return res.status(400).json({ error: 'Missing location parameter' });
  }
  
  // Parse keywords for review filtering
  const reviewKeywords = keywords ? keywords.split(',').map(k => k.trim().toLowerCase()) : [];
  
  try {
    log(`Processing hotel request for location: ${location}`);
    
    // Create a Google search query for hotels
    let searchQuery = `hotels in ${location}`;
    if (checkin && checkout) {
      searchQuery += ` ${checkin} to ${checkout}`;
    }
    if (guests) {
      searchQuery += ` ${guests} guests`;
    }
    
    // Build the Google search URL
    const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}`;
    
    log(`Scraping hotels from Google: ${googleUrl}`);
    
    // Make request to Bright Data API
    const response = await axios({
      url: 'https://api.brightdata.com/request',
      method: 'POST',
      data: {
        url: googleUrl,
        zone: 'serp_api1',
        format: 'json'
      },
      headers: api_headers(),
      responseType: 'json',
    });
    
    log('Received response from Bright Data API');
    
    // Process the response data
    const rawData = response.data;
    let hotels = [];
    
    // Log the raw data structure for debugging
    log('Raw data structure:', typeof rawData === 'object' ? Object.keys(rawData) : typeof rawData);
    
    // Try to parse the body if it's a string (common with Bright Data responses)
    if (rawData && rawData.body && typeof rawData.body === 'string') {
      try {
        // First try to parse as JSON
        if (rawData.body.trim().startsWith('{') || rawData.body.trim().startsWith('[')) {
          log('Attempting to parse response body as JSON');
          const parsedBody = JSON.parse(rawData.body);
          log('Successfully parsed body, structure:', Object.keys(parsedBody));
          
          // If we successfully parsed the body, use it as our data source
          if (parsedBody) {
            // Check for organic results in the parsed body
            if (parsedBody.organic_results && Array.isArray(parsedBody.organic_results)) {
              log(`Found ${parsedBody.organic_results.length} organic results in parsed body`);
              rawData.organic_results = parsedBody.organic_results;
            }
            
            // Check for hotel pack in the parsed body
            if (parsedBody.hotel_pack) {
              log('Found hotel pack in parsed body');
              rawData.hotel_pack = parsedBody.hotel_pack;
            }
            
            // Check for knowledge graph in the parsed body
            if (parsedBody.knowledge_graph) {
              log('Found knowledge graph in parsed body');
              rawData.knowledge_graph = parsedBody.knowledge_graph;
            }
          }
        } 
        // If it's not JSON, it's likely HTML
        else if (rawData.body.includes('<!doctype html>') || rawData.body.includes('<html')) {
          log('Response body appears to be HTML, extracting hotel information directly');
          
          // Store the HTML for later extraction
          rawData.html = rawData.body;
          
          // Extract hotel information from Google search results HTML
          const hotelEntries = [];
          
          // First, try to find Google hotel review sections which have a specific structure
          const hotelReviewSections = rawData.body.match(/<div[^>]*data-hveid[^>]*>[\s\S]*?<h3[^>]*>([^<]+)<\/h3>[\s\S]*?<div[^>]*>([0-9]\.[0-9]|[0-9]) out of [0-9][\s\S]*?<\/div>/g) || [];
          log(`Found ${hotelReviewSections.length} potential hotel review sections in HTML`);
          
          // Process hotel review sections if found
          if (hotelReviewSections.length > 0) {
            hotelReviewSections.forEach((section, index) => {
              // Extract hotel name
              const nameMatch = section.match(/<h3[^>]*>([^<]+)<\/h3>/);
              const name = nameMatch ? nameMatch[1].trim() : `Hotel ${index + 1}`;
              
              // Extract rating
              const ratingMatch = section.match(/([0-9]\.[0-9]|[0-9]) out of [0-9]/);
              const rating = ratingMatch ? ratingMatch[1] : '';
              
              // Extract address
              const addressMatch = section.match(/<div[^>]*>([^<]{5,})<\/div>[\s\S]*?<div[^>]*>([0-9]\.[0-9]|[0-9]) out of [0-9]/);
              const address = addressMatch ? addressMatch[1].trim() : '';
              
              // Extract reviews
              const reviews = [];
              const reviewBlocks = section.match(/<div[^>]*review-snippet[^>]*>[\s\S]*?<span[^>]*>([^<]+)<\/span>[\s\S]*?<\/div>/g) || [];
              
              reviewBlocks.forEach(reviewBlock => {
                const reviewTextMatch = reviewBlock.match(/<span[^>]*>([^<]+)<\/span>/);
                if (reviewTextMatch) {
                  const reviewText = reviewTextMatch[1].trim();
                  if (reviewText) {
                    reviews.push({
                      text: reviewText,
                      source: 'google_review_snippet'
                    });
                  }
                }
              });
              
              // Filter reviews by keywords if provided
              let filteredReviews = reviews;
              if (reviewKeywords.length > 0 && reviews.length > 0) {
                filteredReviews = reviews.filter(review => {
                  const reviewText = review.text.toLowerCase();
                  return reviewKeywords.some(keyword => reviewText.includes(keyword));
                });
                
                if (filteredReviews.length === 0) {
                  filteredReviews = [{
                    text: `No reviews matching keywords: ${reviewKeywords.join(', ')}`,
                    source: 'system_message'
                  }];
                }
              }
              
              hotelEntries.push({
                id: `google_hotel_${index + 1}`,
                name: name,
                address: address,
                description: `Hotel with ${reviews.length} reviews`,
                rating: rating,
                reviews: filteredReviews,
                source: 'google_hotel_review_section'
              });
            });
          }
          
          // If we didn't find any hotel review sections, fall back to standard search results
          if (hotelEntries.length === 0) {
            // Look for hotel listings in the HTML
            // Pattern for hotel listings in Google search results
            const hotelBlocks = rawData.body.match(/<h3[^>]*>([^<]+)<\/h3>[\s\S]*?<cite[^>]*>([^<]+)<\/cite>[\s\S]*?<span[^>]*>([^<]+)<\/span>/g) || [];
            log(`Found ${hotelBlocks.length} potential hotel blocks in HTML`);
            
            // Extract information from each hotel block
            hotelBlocks.forEach((block, index) => {
              // Extract hotel name
              const nameMatch = block.match(/<h3[^>]*>([^<]+)<\/h3>/);
              const name = nameMatch ? nameMatch[1].trim() : `Hotel ${index + 1}`;
              
              // Extract hotel address/website
              const addressMatch = block.match(/<cite[^>]*>([^<]+)<\/cite>/);
              const address = addressMatch ? addressMatch[1].trim() : '';
              
              // Extract description
              const descMatch = block.match(/<span[^>]*>([^<]+)<\/span>/);
              const description = descMatch ? descMatch[1].trim() : '';
              
              // Extract rating if available
              let rating = '';
              const ratingMatch = block.match(/([0-9]\.[0-9]|[0-9]) out of [0-9]|([0-9]\.[0-9]|[0-9]) stars/);
              if (ratingMatch) {
                rating = ratingMatch[1] || ratingMatch[2];
              }
              
              // Only add entries that look like hotels
              if (name.toLowerCase().includes('hotel') || 
                  name.toLowerCase().includes('inn') || 
                  name.toLowerCase().includes('resort') || 
                  description.toLowerCase().includes('hotel') || 
                  description.toLowerCase().includes('star rating')) {
                
                // Extract reviews if available
                const reviews = [];
                
                // Look for review snippets in the block
                const reviewMatches = block.match(/<span class="[^"]*review[^"]*"[^>]*>([^<]+)<\/span>/g) || [];
                reviewMatches.forEach(reviewMatch => {
                  const reviewText = reviewMatch.replace(/<[^>]+>/g, '').trim();
                  if (reviewText) {
                    reviews.push({
                      text: reviewText,
                      source: 'google'
                    });
                  }
                });
                
                // If we couldn't find reviews in the standard way, try an alternative approach
                if (reviews.length === 0) {
                  // Look for any text that might be a review (after the hotel name and address)
                  const potentialReviews = block.replace(/<h3[^>]*>[^<]+<\/h3>/, '')
                                             .replace(/<cite[^>]*>[^<]+<\/cite>/, '')
                                             .match(/<span[^>]*>([^<]{10,})<\/span>/g) || [];
                  
                  potentialReviews.forEach(reviewMatch => {
                    const reviewText = reviewMatch.replace(/<[^>]+>/g, '').trim();
                    if (reviewText && 
                        reviewText.length > 20 && 
                        !reviewText.includes('http') && 
                        !reviews.some(r => r.text === reviewText)) {
                      reviews.push({
                        text: reviewText,
                        source: 'extracted_text'
                      });
                    }
                  });
                }
                
                // Filter reviews by keywords if provided
                let filteredReviews = reviews;
                if (reviewKeywords.length > 0 && reviews.length > 0) {
                  filteredReviews = reviews.filter(review => {
                    const reviewText = review.text.toLowerCase();
                    return reviewKeywords.some(keyword => reviewText.includes(keyword));
                  });
                  
                  // If no reviews match the keywords, include a note
                  if (filteredReviews.length === 0) {
                    filteredReviews = [{
                      text: `No reviews matching keywords: ${reviewKeywords.join(', ')}`,
                      source: 'system_message'
                    }];
                  }
                }
                
                hotelEntries.push({
                  id: `html_hotel_${index + 1}`,
                  name: name,
                  address: address,
                  description: description,
                  rating: rating,
                  reviews: filteredReviews,
                  source: 'html_extraction'
                });
              }
            });
          }
          
          // If we found hotel entries, add them to our results
          if (hotelEntries.length > 0) {
            log(`Extracted ${hotelEntries.length} hotels from HTML content`);
            hotels = hotelEntries;
          }
        }
      } catch (e) {
        log('Error processing response body:', e.message);
      }
    }
    
    // Process Google search results to extract hotel information
    if (rawData && rawData.organic_results && Array.isArray(rawData.organic_results)) {
      log(`Found ${rawData.organic_results.length} organic search results`);
      
      // Filter results that look like hotel listings
      const hotelResults = rawData.organic_results.filter(result => {
        const title = result.title || '';
        const snippet = result.snippet || '';
        // Look for hotel-related keywords in the title or snippet
        return (
          title.toLowerCase().includes('hotel') ||
          title.toLowerCase().includes('inn') ||
          title.toLowerCase().includes('resort') ||
          title.toLowerCase().includes('suites') ||
          snippet.toLowerCase().includes('star hotel') ||
          snippet.toLowerCase().includes('booking') ||
          snippet.toLowerCase().includes('per night') ||
          snippet.toLowerCase().includes('reviews')
        );
      });
      
      log(`Identified ${hotelResults.length} potential hotel listings`);
      
      // Process each hotel result
      hotels = hotelResults.map((result, index) => {
        // Extract rating if available (e.g., "4.5 stars" or "4.5/5")
        let rating = '';
        const ratingMatch = (result.snippet || '').match(/([0-9]\.[0-9]|[0-9])\s*(?:star|out of [0-9]|\/[0-9])/);
        if (ratingMatch) {
          rating = ratingMatch[1];
        }
        
        // Extract price if available (e.g., "$150 per night")
        let price = '';
        const priceMatch = (result.snippet || '').match(/\$([0-9]+)/);
        if (priceMatch) {
          price = '$' + priceMatch[1];
        }
        
        // Extract review count if available
        let reviewCount = '';
        const reviewMatch = (result.snippet || '').match(/([0-9,]+)\s*reviews/);
        if (reviewMatch) {
          reviewCount = reviewMatch[1] + ' reviews';
        }
        
        // Extract potential review snippets from the snippet
        const reviews = [];
        const snippet = result.snippet || '';
        
        // If the snippet is long enough, it might contain a review
        if (snippet.length > 50) {
          // Split by common separators and look for review-like text
          const snippetParts = snippet.split(/[.…]\s+/);
          snippetParts.forEach(part => {
            // Ignore very short parts or parts that are clearly not reviews
            if (part.length > 20 && 
                !part.toLowerCase().includes('http') && 
                !part.toLowerCase().includes('address') && 
                !part.toLowerCase().includes('official site')) {
              reviews.push({
                text: part.trim(),
                source: 'snippet_extraction'
              });
            }
          });
        }
        
        // Filter reviews by keywords if provided
        let filteredReviews = reviews;
        if (reviewKeywords.length > 0 && reviews.length > 0) {
          filteredReviews = reviews.filter(review => {
            const reviewText = review.text.toLowerCase();
            return reviewKeywords.some(keyword => reviewText.includes(keyword));
          });
          
          if (filteredReviews.length === 0 && reviews.length > 0) {
            filteredReviews = [{
              text: `No reviews matching keywords: ${reviewKeywords.join(', ')}`,
              source: 'system_message'
            }];
          }
        }
        
        return {
          id: `hotel_${index + 1}`,
          name: result.title || `Hotel ${index + 1}`,
          address: result.displayed_link || '',
          description: result.snippet || '',
          price: price,
          rating: rating,
          reviewCount: reviewCount,
          reviews: filteredReviews,
          url: result.link || '',
          position: result.position || index + 1,
          source: 'google_organic'
        };
      });
    }
    
    // Check for Google's hotel pack results (special hotel listings)
    if (rawData && rawData.hotel_pack && rawData.hotel_pack.hotels && Array.isArray(rawData.hotel_pack.hotels)) {
      log(`Found ${rawData.hotel_pack.hotels.length} hotels in hotel pack`);
      
      // Process each hotel from the hotel pack
      const hotelPackResults = rawData.hotel_pack.hotels.map((hotel, index) => {
        // Extract reviews if available
        const reviews = [];
        if (hotel.reviews_text) {
          reviews.push({
            text: hotel.reviews_text,
            source: 'hotel_pack'
          });
        }
        
        // Filter reviews by keywords if provided
        let filteredReviews = reviews;
        if (reviewKeywords.length > 0 && reviews.length > 0) {
          filteredReviews = reviews.filter(review => {
            const reviewText = review.text.toLowerCase();
            return reviewKeywords.some(keyword => reviewText.includes(keyword));
          });
          
          if (filteredReviews.length === 0 && reviews.length > 0) {
            filteredReviews = [{
              text: `No reviews matching keywords: ${reviewKeywords.join(', ')}`,
              source: 'system_message'
            }];
          }
        }
        
        return {
          id: `pack_hotel_${index + 1}`,
          name: hotel.name || `Hotel ${index + 1}`,
          address: hotel.address || '',
          price: hotel.price || '',
          rating: hotel.rating || '',
          reviewCount: hotel.reviews || '',
          reviews: filteredReviews,
          imageUrl: hotel.thumbnail || '',
          url: hotel.link || '',
          source: 'google_hotel_pack'
        };
      });
      
      // Add hotel pack results to our hotels array
      hotels = [...hotels, ...hotelPackResults];
    }
    
    // Check for knowledge graph information (for specific hotel searches)
    if (rawData && rawData.knowledge_graph) {
      const kg = rawData.knowledge_graph;
      log('Found knowledge graph data');
      
      if (kg.title && (kg.type === 'Hotel' || (kg.description && kg.description.toLowerCase().includes('hotel')))) {
        // Extract reviews if available
        const reviews = [];
        if (kg.reviews_text) {
          reviews.push({
            text: kg.reviews_text,
            source: 'knowledge_graph'
          });
        }
        
        // Filter reviews by keywords if provided
        let filteredReviews = reviews;
        if (reviewKeywords.length > 0 && reviews.length > 0) {
          filteredReviews = reviews.filter(review => {
            const reviewText = review.text.toLowerCase();
            return reviewKeywords.some(keyword => reviewText.includes(keyword));
          });
          
          if (filteredReviews.length === 0 && reviews.length > 0) {
            filteredReviews = [{
              text: `No reviews matching keywords: ${reviewKeywords.join(', ')}`,
              source: 'system_message'
            }];
          }
        }
        
        hotels.push({
          id: 'knowledge_graph_hotel',
          name: kg.title || '',
          address: kg.address || '',
          description: kg.description || '',
          rating: kg.rating || '',
          reviewCount: kg.reviews || '',
          reviews: filteredReviews,
          imageUrl: kg.thumbnail || '',
          phone: kg.phone || '',
          website: kg.website || '',
          source: 'google_knowledge_graph'
        });
      }
    }
    
    // If we still don't have hotels, create a mock response for debugging
    if (hotels.length === 0) {
      log('No hotels found in the response, creating sample data for debugging');
      
      // Create sample hotel data for debugging purposes
      hotels = [
        {
          id: 'sample_1',
          name: 'Sample Hotel 1',
          address: `Sample address in ${location}`,
          price: '$150',
          rating: '4.5',
          reviewCount: '253 reviews',
          reviews: [
            {
              text: 'This is a sample review for debugging purposes. Great hotel with excellent service.',
              source: 'sample'
            }
          ],
          description: 'This is a sample hotel for debugging purposes',
          features: ['WiFi', 'Breakfast included', 'Swimming pool'],
          note: 'This is sample data because no actual hotels were found in the API response'
        },
        {
          id: 'sample_2',
          name: 'Sample Hotel 2',
          address: `Another address in ${location}`,
          price: '$210',
          rating: '4.2',
          reviewCount: '187 reviews',
          reviews: [
            {
              text: 'Another sample review. Comfortable rooms but the breakfast could be better.',
              source: 'sample'
            }
          ],
          description: 'Another sample hotel for debugging purposes',
          features: ['Parking', 'Restaurant', 'Fitness center'],
          note: 'This is sample data because no actual hotels were found in the API response'
        }
      ];
    }
    
    // Create a well-structured response
    const formattedResponse = {
      success: true,
      query: {
        location,
        checkin: checkin || 'not specified',
        checkout: checkout || 'not specified',
        guests: guests || 'not specified',
        keywords: reviewKeywords.length > 0 ? reviewKeywords : 'not specified'
      },
      results: {
        hotels: hotels,
        totalResults: hotels.length,
        pagination: rawData.pagination || { current_page: 1 }
      }
    };
    
    log(`Returning ${hotels.length} hotels for ${location}`);
    res.json(formattedResponse);
  } catch (err) {
    // Enhanced error handling
    log('Error scraping hotels:', err.message);
    if (err.response && err.response.data) {
      log('API Error details:', err.response.data);
    }
    
    // Return a detailed error response
    res.status(500).json({ 
      success: false, 
      error: err.message || 'Hotel scraping failed',
      query: { location, checkin, checkout, guests, keywords },
      details: err.response && err.response.data ? err.response.data : {}
    });
  }
});
