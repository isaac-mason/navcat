import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const readmeTemplatePath = path.join(path.dirname(new URL(import.meta.url).pathname), './README.template.md');
const readmeOutPath = path.join(path.dirname(new URL(import.meta.url).pathname), '../README.md');

let readmeText = fs.readFileSync(readmeTemplatePath, 'utf-8');

/* handle <RenderType="import('navcat').TypeName" /> */
const renderTypeRegex = /<RenderType="import\([']navcat[']\)\.(\w+)"\s*\/>/g;
readmeText = readmeText.replace(renderTypeRegex, (fullMatch, typeName) => {
    const typeDef = extractType(typeName);
    if (!typeDef) {
        console.warn(`Type ${typeName} not found`);
        return fullMatch;
    }
    return `\`\`\`ts\n${typeDef}\n\`\`\``;
});

/* handle <Snippet source="./snippets/file.ts" select="group" /> */
const snippetRegex = /<Snippet\s+source=["'](.+?)["']\s+select=["'](.+?)["']\s*\/>/g;
readmeText = readmeText.replace(snippetRegex, (fullMatch, sourcePath, groupName) => {
    const absSourcePath = path.join(path.dirname(new URL(import.meta.url).pathname), sourcePath);
    if (!fs.existsSync(absSourcePath)) {
        console.warn(`Snippet source file not found: ${absSourcePath}`);
        return fullMatch;
    }
    const sourceText = fs.readFileSync(absSourcePath, 'utf-8');

    // extract the selected group
    const groupRegex = new RegExp(
        `/\\*\\s*SNIPPET_START:\\s*${groupName}\\s*\\*/([\\s\\S]*?)/\\*\\s*SNIPPET_END:\\s*${groupName}\\s*\\*/`,
        'g',
    );
    const match = groupRegex.exec(sourceText);
    if (!match) {
        console.warn(`Snippet group '${groupName}' not found in ${sourcePath}`);
        return fullMatch;
    }
    const snippetCode = match[1].trim();

    return `\`\`\`ts\n${snippetCode}\n\`\`\``;
});

/* write result */
fs.writeFileSync(readmeOutPath, readmeText, 'utf-8');

/* utils */
function extractType(typeName) {
    // find all .ts files in src
    const srcDir = path.join(path.dirname(new URL(import.meta.url).pathname), '../src');
    function getAllSourceFiles(dir) {
        let files = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                files = files.concat(getAllSourceFiles(fullPath));
            } else if (entry.isFile() && entry.name.endsWith('.ts')) {
                files.push(fullPath);
            }
        }
        return files;
    }
    const dtsFiles = getAllSourceFiles(srcDir);

    // create a TypeScript program from all .ts files
    const program = ts.createProgram(dtsFiles, {
        allowJs: false,
        declaration: true,
        emitDeclarationOnly: true,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        strict: true,
        noEmit: true,
    });

    let found = null;
    function visit(node, fileText) {
        if (
            (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) &&
            node.name &&
            node.name.text === typeName
        ) {
            found = fileText.slice(node.getFullStart(), node.getEnd());
        }
        ts.forEachChild(node, child => visit(child, fileText));
    }

    // Search all files for the type
    for (const file of dtsFiles) {
        const sf = program.getSourceFile(file);
        if (sf) {
            const fileText = sf.getFullText();
            visit(sf, fileText);
        }
        if (found) break;
    }

    return found ? found.trimStart() : null;
}