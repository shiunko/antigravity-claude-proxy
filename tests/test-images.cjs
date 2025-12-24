/**
 * Image Support Test
 *
 * Tests that images can be sent to the API with thinking models.
 * Simulates Claude Code sending screenshots or images for analysis.
 */
const fs = require('fs');
const path = require('path');
const { streamRequest } = require('./helpers/http-client.cjs');

// Load test image from disk
const TEST_IMAGE_PATH = path.join(__dirname, 'utils', 'test_image.jpeg');
const TEST_IMAGE_BASE64 = fs.readFileSync(TEST_IMAGE_PATH).toString('base64');

async function runTests() {
    console.log('='.repeat(60));
    console.log('IMAGE SUPPORT TEST');
    console.log('Tests image processing with thinking models');
    console.log('='.repeat(60));
    console.log('');

    let allPassed = true;
    const results = [];

    // ===== TEST 1: Single image with question =====
    console.log('TEST 1: Single image with question');
    console.log('-'.repeat(40));

    const result1 = await streamRequest({
        model: 'claude-sonnet-4-5-thinking',
        max_tokens: 2048,
        stream: true,
        thinking: { type: 'enabled', budget_tokens: 8000 },
        messages: [{
            role: 'user',
            content: [
                {
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: 'image/jpeg',
                        data: TEST_IMAGE_BASE64
                    }
                },
                {
                    type: 'text',
                    text: 'What do you see in this image? Describe it briefly.'
                }
            ]
        }]
    });

    if (result1.error) {
        console.log(`  ERROR: ${result1.error.message}`);
        allPassed = false;
        results.push({ name: 'Single image processing', passed: false });
    } else {
        const thinking = result1.content.filter(b => b.type === 'thinking');
        const text = result1.content.filter(b => b.type === 'text');

        console.log(`  Thinking: ${thinking.length > 0 ? 'YES' : 'NO'}`);
        console.log(`  Text response: ${text.length > 0 ? 'YES' : 'NO'}`);

        if (thinking.length > 0) {
            console.log(`  Thinking: "${thinking[0].thinking?.substring(0, 60)}..."`);
        }
        if (text.length > 0) {
            console.log(`  Response: "${text[0].text?.substring(0, 100)}..."`);
        }

        const passed = thinking.length > 0 && text.length > 0;
        results.push({ name: 'Single image processing', passed });
        if (!passed) allPassed = false;
    }

    // ===== TEST 2: Image + text in multi-turn =====
    console.log('\nTEST 2: Image in multi-turn conversation');
    console.log('-'.repeat(40));

    const result2 = await streamRequest({
        model: 'claude-sonnet-4-5-thinking',
        max_tokens: 2048,
        stream: true,
        thinking: { type: 'enabled', budget_tokens: 8000 },
        messages: [
            {
                role: 'user',
                content: 'I will show you an image.'
            },
            {
                role: 'assistant',
                content: [{
                    type: 'text',
                    text: 'Sure, please share the image and I\'ll help analyze it.'
                }]
            },
            {
                role: 'user',
                content: [
                    {
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: 'image/jpeg',
                            data: TEST_IMAGE_BASE64
                        }
                    },
                    {
                        type: 'text',
                        text: 'Here is the image. What do you see?'
                    }
                ]
            }
        ]
    });

    if (result2.error) {
        console.log(`  ERROR: ${result2.error.message}`);
        allPassed = false;
        results.push({ name: 'Image in multi-turn', passed: false });
    } else {
        const thinking = result2.content.filter(b => b.type === 'thinking');
        const text = result2.content.filter(b => b.type === 'text');

        console.log(`  Thinking: ${thinking.length > 0 ? 'YES' : 'NO'}`);
        console.log(`  Text response: ${text.length > 0 ? 'YES' : 'NO'}`);

        if (text.length > 0) {
            console.log(`  Response: "${text[0].text?.substring(0, 80)}..."`);
        }

        const passed = text.length > 0;
        results.push({ name: 'Image in multi-turn', passed });
        if (!passed) allPassed = false;
    }

    // ===== Summary =====
    console.log('\n' + '='.repeat(60));
    console.log('SUMMARY');
    console.log('='.repeat(60));

    for (const result of results) {
        const status = result.passed ? 'PASS' : 'FAIL';
        console.log(`  [${status}] ${result.name}`);
    }

    console.log('\n' + '='.repeat(60));
    console.log(`OVERALL: ${allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'}`);
    console.log('='.repeat(60));

    process.exit(allPassed ? 0 : 1);
}

runTests().catch(err => {
    console.error('Test failed with error:', err);
    process.exit(1);
});
