/**
 * Thinking Signature Test
 *
 * Tests that thinking blocks with signatures are properly handled in multi-turn
 * conversations, simulating how Claude Code sends requests.
 *
 * Claude Code sends assistant messages with thinking blocks that include signatures.
 * These signatures must be preserved and sent back to the API.
 */
const { streamRequest, commonTools } = require('./helpers/http-client.cjs');

const tools = [commonTools.getWeather];

async function runTests() {
    console.log('='.repeat(60));
    console.log('THINKING SIGNATURE TEST');
    console.log('Simulates Claude Code multi-turn with thinking blocks');
    console.log('='.repeat(60));
    console.log('');

    let allPassed = true;
    const results = [];

    // ===== TEST 1: First turn - get thinking block with signature =====
    console.log('TEST 1: Initial request with thinking model');
    console.log('-'.repeat(40));

    const turn1Messages = [
        { role: 'user', content: 'What is the weather in Paris? Use the get_weather tool.' }
    ];

    const turn1Result = await streamRequest({
        model: 'claude-sonnet-4-5-thinking',
        max_tokens: 4096,
        stream: true,
        tools,
        thinking: { type: 'enabled', budget_tokens: 10000 },
        messages: turn1Messages
    });

    const turn1Thinking = turn1Result.content.filter(b => b.type === 'thinking');
    const turn1ToolUse = turn1Result.content.filter(b => b.type === 'tool_use');
    const turn1Text = turn1Result.content.filter(b => b.type === 'text');

    console.log(`  Thinking blocks: ${turn1Thinking.length}`);
    console.log(`  Tool use blocks: ${turn1ToolUse.length}`);
    console.log(`  Text blocks: ${turn1Text.length}`);

    // Check thinking has signature
    let turn1HasSignature = false;
    if (turn1Thinking.length > 0) {
        const sig = turn1Thinking[0].signature || '';
        turn1HasSignature = sig.length >= 50;
        console.log(`  Signature length: ${sig.length} chars`);
        console.log(`  Signature present: ${turn1HasSignature ? 'YES' : 'NO'}`);
        if (turn1Thinking[0].thinking) {
            console.log(`  Thinking preview: "${turn1Thinking[0].thinking.substring(0, 80)}..."`);
        }
    }

    const test1Pass = turn1Thinking.length > 0 && turn1HasSignature && turn1ToolUse.length > 0;
    results.push({ name: 'Turn 1: Thinking + Signature + Tool Use', passed: test1Pass });
    console.log(`  Result: ${test1Pass ? 'PASS' : 'FAIL'}`);
    if (!test1Pass) allPassed = false;

    // ===== TEST 2: Second turn - send back thinking with signature =====
    console.log('\nTEST 2: Multi-turn with thinking signature in assistant message');
    console.log('-'.repeat(40));

    if (!turn1ToolUse.length) {
        console.log('  SKIPPED - No tool use in turn 1');
        results.push({ name: 'Turn 2: Multi-turn with signature', passed: false, skipped: true });
    } else {
        // Build assistant message with thinking (including signature) - this is how Claude Code sends it
        const assistantContent = turn1Result.content;

        // Verify the thinking block has signature before sending
        const thinkingInAssistant = assistantContent.find(b => b.type === 'thinking');
        if (thinkingInAssistant) {
            console.log(`  Sending thinking with signature: ${(thinkingInAssistant.signature || '').length} chars`);
        }

        const turn2Messages = [
            ...turn1Messages,
            { role: 'assistant', content: assistantContent },
            {
                role: 'user',
                content: [{
                    type: 'tool_result',
                    tool_use_id: turn1ToolUse[0].id,
                    content: 'The weather in Paris is 18°C and sunny.'
                }]
            }
        ];

        const turn2Result = await streamRequest({
            model: 'claude-sonnet-4-5-thinking',
            max_tokens: 4096,
            stream: true,
            tools,
            thinking: { type: 'enabled', budget_tokens: 10000 },
            messages: turn2Messages
        });

        const turn2Thinking = turn2Result.content.filter(b => b.type === 'thinking');
        const turn2Text = turn2Result.content.filter(b => b.type === 'text');

        console.log(`  Thinking blocks: ${turn2Thinking.length}`);
        console.log(`  Text blocks: ${turn2Text.length}`);

        // Check for errors
        const hasError = turn2Result.events.some(e => e.type === 'error');
        if (hasError) {
            const errorEvent = turn2Result.events.find(e => e.type === 'error');
            console.log(`  ERROR: ${errorEvent?.data?.error?.message || 'Unknown error'}`);
        }

        if (turn2Thinking.length > 0) {
            const sig = turn2Thinking[0].signature || '';
            console.log(`  New signature length: ${sig.length} chars`);
            if (turn2Thinking[0].thinking) {
                console.log(`  Thinking preview: "${turn2Thinking[0].thinking.substring(0, 80)}..."`);
            }
        }

        if (turn2Text.length > 0 && turn2Text[0].text) {
            console.log(`  Response: "${turn2Text[0].text.substring(0, 100)}..."`);
        }

        const test2Pass = !hasError && (turn2Thinking.length > 0 || turn2Text.length > 0);
        results.push({ name: 'Turn 2: Multi-turn with signature', passed: test2Pass });
        console.log(`  Result: ${test2Pass ? 'PASS' : 'FAIL'}`);
        if (!test2Pass) allPassed = false;
    }

    // ===== TEST 3: Verify signature_delta events in stream =====
    console.log('\nTEST 3: Verify signature_delta events in stream');
    console.log('-'.repeat(40));

    const signatureDeltas = turn1Result.events.filter(
        e => e.type === 'content_block_delta' && e.data?.delta?.type === 'signature_delta'
    );
    console.log(`  signature_delta events: ${signatureDeltas.length}`);

    if (signatureDeltas.length > 0) {
        const totalSigLength = signatureDeltas.reduce((sum, e) => sum + (e.data.delta.signature?.length || 0), 0);
        console.log(`  Total signature length from deltas: ${totalSigLength} chars`);
    }

    const test3Pass = signatureDeltas.length > 0;
    results.push({ name: 'signature_delta events present', passed: test3Pass });
    console.log(`  Result: ${test3Pass ? 'PASS' : 'FAIL'}`);
    if (!test3Pass) allPassed = false;

    // ===== Summary =====
    console.log('\n' + '='.repeat(60));
    console.log('SUMMARY');
    console.log('='.repeat(60));

    for (const result of results) {
        const status = result.skipped ? 'SKIP' : (result.passed ? 'PASS' : 'FAIL');
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
