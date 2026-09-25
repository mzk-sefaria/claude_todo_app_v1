#!/usr/bin/env node

/**
 * Granola → Notion Daily Sync
 * Fetches meetings from Granola, extracts action items via Claude, writes to Notion
 */

import fetch from 'node-fetch';
import fs from 'fs';

const log = (msg) => {
  console.log(msg);
  fs.appendFileSync('/tmp/granola-sync.log', msg + '\n');
};

// Determine date range for meetings to fetch
function getDateRange() {
  const today = new Date();
  const dayOfWeek = today.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  
  let sinceDate;
  if (dayOfWeek === 1) {
    // Monday: fetch from Friday (3 days back)
    sinceDate = new Date(today);
    sinceDate.setDate(sinceDate.getDate() - 3);
  } else if (dayOfWeek > 1 && dayOfWeek <= 5) {
    // Tue-Fri: fetch from yesterday
    sinceDate = new Date(today);
    sinceDate.setDate(sinceDate.getDate() - 1);
  } else {
    // Shouldn't run on weekends, but fallback to yesterday
    sinceDate = new Date(today);
    sinceDate.setDate(sinceDate.getDate() - 1);
  }
  
  return sinceDate.toISOString().split('T')[0];
}

async function fetchGranolaMeetings(apiKey, sinceDate) {
  log(`[Granola] Fetching meetings since ${sinceDate}...`);
  
  const res = await fetch('https://api.granola.ai/v1/meetings', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  
  if (!res.ok) {
    throw new Error(`Granola API error: ${res.status} ${res.statusText}`);
  }
  
  const data = await res.json();
  const meetings = Array.isArray(data) ? data : data.meetings || [];
  
  log(`[Granola] Found ${meetings.length} meetings`);
  return meetings;
}

async function getTranscript(apiKey, meetingId) {
  const res = await fetch(`https://api.granola.ai/v1/meetings/${meetingId}/transcript`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  
  if (!res.ok) return null;
  const data = await res.json();
  return typeof data === 'string' ? data : data.transcript || JSON.stringify(data);
}

async function extractActionItems(transcript, anthropicKey) {
  const prompt = `Extract action items from this meeting transcript that are specifically assigned to or for Michael. Return ONLY a JSON array of strings, each being a concise action item (max 100 chars). If none, return []. Transcript:\n\n${transcript}`;
  
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': anthropicKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-1',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  
  if (!res.ok) {
    log(`[Claude] API error: ${res.status}`);
    return [];
  }
  
  const data = await res.json();
  const content = data.content?.[0]?.text || '';
  
  try {
    // Extract JSON from response (may have markdown fences)
    const jsonMatch = content.match(/\[.*\]/s);
    if (!jsonMatch) return [];
    const items = JSON.parse(jsonMatch[0]);
    return Array.isArray(items) ? items : [];
  } catch {
    log(`[Claude] Failed to parse response: ${content.slice(0, 100)}`);
    return [];
  }
}

async function createNotionPage(notionKey, dbId, title, type, person, priority) {
  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${notionKey}`,
      'Notion-Version': '2022-06-28',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      parent: { database_id: dbId },
      properties: {
        'Entry': { title: [{ text: { content: title } }] },
        'Type': { select: { name: type } },
        'Person': { rich_text: [{ text: { content: person } }] },
        'Priority': { select: { name: priority } },
        'Status': { select: { name: 'Open' } },
      },
    }),
  });
  
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Notion API error: ${res.status} ${err}`);
  }
  
  return res.json();
}

async function main() {
  const granolaKey = process.env.GRANOLA_API_KEY;
  const notionKey = process.env.NOTION_API_KEY;
  const notionDbId = process.env.NOTION_DATABASE_ID;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  
  if (!granolaKey || !notionKey || !notionDbId || !anthropicKey) {
    throw new Error('Missing required environment variables. Set GRANOLA_API_KEY, NOTION_API_KEY, NOTION_DATABASE_ID, ANTHROPIC_API_KEY.');
  }
  
  const sinceDate = getDateRange();
  log(`[Start] Syncing meetings since ${sinceDate}`);
  
  try {
    const meetings = await fetchGranolaMeetings(granolaKey, sinceDate);
    
    if (meetings.length === 0) {
      log('[End] No meetings found.');
      return;
    }
    
    let created = 0;
    
    for (const meeting of meetings.slice(0, 10)) {
      log(`[Meeting] ${meeting.title}`);
      
      try {
        const transcript = await getTranscript(granolaKey, meeting.id);
        if (!transcript) {
          log(`  → No transcript available`);
          continue;
        }
        
        const items = await extractActionItems(transcript, anthropicKey);
        log(`  → Extracted ${items.length} action item(s)`);
        
        for (const item of items) {
          try {
            await createNotionPage(notionKey, notionDbId, item, 'Follow-up', meeting.title || 'Granola Meeting', 'Medium');
            created++;
            log(`    ✓ Created: "${item.slice(0, 50)}..."`);
          } catch (e) {
            log(`    ✗ Failed to create: ${e.message}`);
          }
        }
      } catch (e) {
        log(`  → Error processing: ${e.message}`);
      }
    }
    
    log(`[End] Created ${created} action item(s)`);
  } catch (error) {
    log(`[Error] ${error.message}`);
    throw error;
  }
}

main().catch(error => {
  console.error('Fatal error:', error.message);
  process.exit(1);
});
