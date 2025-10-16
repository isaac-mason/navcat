import { createHeightfield, addHeightfieldSpan, buildCompactHeightfield, BuildContext, markRotatedBoxArea } from './dist/index.js';

const createGridWithSpans = (size) => {
    const heightfield = createHeightfield(size, size, [[0, 0, 0], [size, 10, size]], 1.0, 1.0);
    for (let x = 0; x < size; x++) {
        for (let z = 0; z < size; z++) {
            addHeightfieldSpan(heightfield, x, z, 0, 10, 1, 1);
        }
    }
    const ctx = BuildContext.create();
    return buildCompactHeightfield(ctx, 5, 3, heightfield);
};

const visualize = (compact, size, areaId, title) => {
    console.log(`\n=== ${title} ===`);
    const marked = [];
    for (let z = 0; z < size; z++) {
        let row = '';
        for (let x = 0; x < size; x++) {
            const cell = compact.cells[x + z * size];
            if (compact.areas[cell.index] === areaId) {
                row += 'X';
                marked.push({ x, z });
            } else {
                row += '.';
            }
        }
        console.log(row);
    }
    console.log('Marked positions:', JSON.stringify(marked));
    return marked;
};

console.log('Testing markRotatedBoxArea');
console.log('Grid cell size: 1.0, so cell centers are at 0.5, 1.5, 2.5, etc.');
console.log('');

// Test 1: 0 degrees
{
    const compact = createGridWithSpans(7);
    console.log('Test 1: Box at 0 degrees');
    console.log('Center: [3.5, 5, 3.5], HalfExtents: [1.5, 5, 1.5]');
    console.log('Box extends from X:[2.0-5.0], Z:[2.0-5.0]');
    console.log('Cell centers: X:[2.5, 3.5, 4.5], Z:[2.5, 3.5, 4.5]');
    console.log('Expected cells: (2,2), (3,2), (4,2), (2,3), (3,3), (4,3), (2,4), (3,4), (4,4)');
    markRotatedBoxArea([3.5, 5, 3.5], [1.5, 5, 1.5], 0, 2, compact);
    const marked = visualize(compact, 7, 2, '0 degrees result');
}

// Test 2: 45 degrees
{
    const compact = createGridWithSpans(9);
    console.log('\nTest 2: Box at 45 degrees');
    console.log('Center: [4.5, 5, 4.5], HalfExtents: [1.0, 5, 1.0]');
    console.log('A 1x1 square rotated 45° forms a diamond with diagonal ~1.414');
    markRotatedBoxArea([4.5, 5, 4.5], [1.0, 5, 1.0], Math.PI / 4, 3, compact);
    visualize(compact, 9, 3, '45 degrees result');
}

// Test 3: Rectangle at 0 degrees
{
    const compact = createGridWithSpans(9);
    console.log('\nTest 3: Rectangle at 0 degrees');
    console.log('Center: [4.5, 5, 4.5], HalfExtents: [2.0, 5, 1.0]');
    console.log('Box extends from X:[2.5-6.5], Z:[3.5-5.5]');
    markRotatedBoxArea([4.5, 5, 4.5], [2.0, 5, 1.0], 0, 4, compact);
    visualize(compact, 9, 4, 'Rectangle 0° result');
}

// Test 4: Rectangle at 90 degrees
{
    const compact = createGridWithSpans(9);
    console.log('\nTest 4: Same rectangle at 90 degrees (should rotate)');
    console.log('Center: [4.5, 5, 4.5], HalfExtents: [2.0, 5, 1.0]');
    console.log('After 90° rotation, X extent (2.0) becomes Z, Z extent (1.0) becomes X');
    markRotatedBoxArea([4.5, 5, 4.5], [2.0, 5, 1.0], Math.PI / 2, 5, compact);
    visualize(compact, 9, 5, 'Rectangle 90° result');
}

// Test 5: Check Y bounds
{
    const heightfield = createHeightfield(5, 5, [[0, 0, 0], [5, 10, 5]], 1.0, 1.0);
    addHeightfieldSpan(heightfield, 2, 2, 0, 5, 1, 1); // Low span (y=5)
    addHeightfieldSpan(heightfield, 2, 2, 15, 20, 2, 1); // High span (y=20)
    const compact = buildCompactHeightfield(BuildContext.create(), 5, 3, heightfield);
    
    console.log('\nTest 5: Y bounds test');
    console.log('Cell (2,2) has 2 spans: y=5 (area=1) and y=20 (area=2)');
    console.log('Box Y range: [0, 7] (center=3.5, halfExtent=3.5)');
    console.log('Should mark only the low span');
    
    markRotatedBoxArea([2.5, 3.5, 2.5], [1.0, 3.5, 1.0], 0, 8, compact);
    
    const cell = compact.cells[2 + 2 * 5];
    console.log('Low span area:', compact.areas[cell.index], '(expected: 8)');
    console.log('High span area:', compact.areas[cell.index + 1], '(expected: 2)');
}

console.log('\n✅ Manual testing complete!');
