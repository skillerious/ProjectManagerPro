const path = require('path');
const fs = require('fs').promises;

async function createElectronProject(projectPath, name, description) {
  const packageJson = {
    name: name.toLowerCase().replace(/\s+/g, '-'),
    version: "0.1.0",
    description: description,
    main: "main.js",
    scripts: {
      start: "electron .",
      build: "electron-builder"
    },
    devDependencies: {
      electron: "^39.2.3"
    }
  };
  
  const mainJs = `const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});`;

  const preloadJs = `const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('appInfo', {
  electron: process.versions.electron
});`;

  const indexHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${name}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      margin: 0;
      padding: 20px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      height: 100vh;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
    }
    h1 { margin-bottom: 10px; }
    p { opacity: 0.9; }
  </style>
</head>
	<body>
	  <h1>Welcome to ${name}</h1>
	  <p>${description}</p>
	  <p>Electron: <span id="electron-version"></span></p>
	  <script>
	    const version = window.appInfo && window.appInfo.electron ? window.appInfo.electron : 'unknown';
	    document.getElementById('electron-version').textContent = version;
	  </script>
	</body>
	</html>`;
	  
  await fs.writeFile(path.join(projectPath, 'package.json'), JSON.stringify(packageJson, null, 2));
  await fs.writeFile(path.join(projectPath, 'main.js'), mainJs);
  await fs.writeFile(path.join(projectPath, 'preload.js'), preloadJs);
  await fs.writeFile(path.join(projectPath, 'index.html'), indexHtml);
  await fs.writeFile(path.join(projectPath, '.gitignore'), 'node_modules/\ndist/\n*.log');
  await fs.writeFile(path.join(projectPath, 'README.md'), `# ${name}\n\n${description}\n\n## Getting Started\n\n\`\`\`bash\nnpm install\nnpm start\n\`\`\``);
}

async function createPythonProject(projectPath, name, description) {
  const mainPy = `#!/usr/bin/env python3
"""
${name}
${description}
"""

def main():
    """Main function"""
    print(f"Welcome to ${name}")
    print(f"${description}")
    
if __name__ == "__main__":
    main()
`;

  const requirements = `# Core dependencies
numpy>=1.21.0
pandas>=1.3.0
requests>=2.26.0
`;

  const gitignore = `# Python
__pycache__/
*.py[cod]
*$py.class
*.so
.Python
env/
venv/
ENV/
build/
dist/
*.egg-info/
.venv
pip-log.txt
pip-delete-this-directory.txt

# IDE
.vscode/
.idea/
*.swp
*.swo
*~

# Project specific
*.log
.DS_Store
`;

  const readme = `# ${name}

${description}

## Setup

\`\`\`bash
python -m venv venv
source venv/bin/activate  # On Windows: venv\\Scripts\\activate
pip install -r requirements.txt
\`\`\`

## Usage

\`\`\`bash
python main.py
\`\`\`
`;

  await fs.writeFile(path.join(projectPath, 'main.py'), mainPy);
  await fs.writeFile(path.join(projectPath, 'requirements.txt'), requirements);
  await fs.writeFile(path.join(projectPath, '.gitignore'), gitignore);
  await fs.writeFile(path.join(projectPath, 'README.md'), readme);
  
  // Create project structure
  await fs.mkdir(path.join(projectPath, 'src'), { recursive: true });
  await fs.mkdir(path.join(projectPath, 'tests'), { recursive: true });
  await fs.mkdir(path.join(projectPath, 'docs'), { recursive: true });
  
  await fs.writeFile(path.join(projectPath, 'src', '__init__.py'), '');
  await fs.writeFile(path.join(projectPath, 'tests', '__init__.py'), '');
}

async function createWebProject(projectPath, name, description) {
  const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${name}</title>
    <link rel="stylesheet" href="css/style.css">
</head>
<body>
    <div class="container">
        <header>
            <h1>${name}</h1>
            <nav>
                <ul>
                    <li><a href="#home">Home</a></li>
                    <li><a href="#about">About</a></li>
                    <li><a href="#services">Services</a></li>
                    <li><a href="#contact">Contact</a></li>
                </ul>
            </nav>
        </header>
        
        <main>
            <section id="hero">
                <h2>Welcome to ${name}</h2>
                <p>${description}</p>
                <button class="cta-button">Get Started</button>
            </section>
        </main>
        
        <footer>
            <p>&copy; 2026 ${name}. All rights reserved.</p>
        </footer>
    </div>
    
    <script src="js/script.js"></script>
</body>
</html>`;

  const styleCss = `* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    line-height: 1.6;
    color: #333;
}

.container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 0 20px;
}

header {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    padding: 1rem 0;
    box-shadow: 0 2px 10px rgba(0,0,0,0.1);
}

header h1 {
    display: inline-block;
    margin-right: 2rem;
}

nav {
    display: inline-block;
}

nav ul {
    list-style: none;
    display: flex;
    gap: 2rem;
}

nav a {
    color: white;
    text-decoration: none;
    transition: opacity 0.3s;
}

nav a:hover {
    opacity: 0.8;
}

#hero {
    padding: 4rem 0;
    text-align: center;
    background: #f8f9fa;
    margin: 2rem 0;
    border-radius: 10px;
}

#hero h2 {
    font-size: 2.5rem;
    margin-bottom: 1rem;
}

#hero p {
    font-size: 1.2rem;
    margin-bottom: 2rem;
    color: #666;
}

.cta-button {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border: none;
    padding: 1rem 2rem;
    font-size: 1.1rem;
    border-radius: 50px;
    cursor: pointer;
    transition: transform 0.3s;
}

.cta-button:hover {
    transform: translateY(-2px);
}

footer {
    background: #333;
    color: white;
    text-align: center;
    padding: 2rem 0;
    margin-top: 4rem;
}`;

  const scriptJs = `// ${name} JavaScript
document.addEventListener('DOMContentLoaded', function() {
    console.log('${name} loaded successfully');
    
    // Smooth scrolling for navigation links
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();
            const target = document.querySelector(this.getAttribute('href'));
            if (target) {
                target.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                });
            }
        });
    });
    
    // CTA button click handler
    const ctaButton = document.querySelector('.cta-button');
    if (ctaButton) {
        ctaButton.addEventListener('click', function() {
            alert('Welcome to ${name}!');
        });
    }
});`;

  await fs.mkdir(path.join(projectPath, 'css'), { recursive: true });
  await fs.mkdir(path.join(projectPath, 'js'), { recursive: true });
  await fs.mkdir(path.join(projectPath, 'images'), { recursive: true });
  
  await fs.writeFile(path.join(projectPath, 'index.html'), indexHtml);
  await fs.writeFile(path.join(projectPath, 'css', 'style.css'), styleCss);
  await fs.writeFile(path.join(projectPath, 'js', 'script.js'), scriptJs);
  await fs.writeFile(path.join(projectPath, 'README.md'), `# ${name}\n\n${description}\n\n## Features\n\n- Responsive design\n- Modern CSS with gradients\n- Smooth scrolling\n- Clean structure`);
}

async function createNodeProject(projectPath, name, description) {
  const packageJson = {
    name: name.toLowerCase().replace(/\s+/g, '-'),
    version: "1.0.0",
    description: description,
    main: "index.js",
    scripts: {
      start: "node index.js",
      dev: "nodemon index.js",
      test: "jest"
    },
    keywords: [],
    author: "",
    license: "ISC",
    dependencies: {
      express: "^4.18.0",
      dotenv: "^16.0.0"
    },
    devDependencies: {
      nodemon: "^2.0.0",
      jest: "^29.0.0"
    }
  };
  
  const indexJs = `const express = require('express');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Routes
app.get('/', (req, res) => {
    res.json({
        name: '${name}',
        description: '${description}',
        version: '1.0.0'
    });
});

app.get('/api/status', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString()
    });
});

// Error handling
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something went wrong!' });
});

// Start server
app.listen(PORT, () => {
    console.log(\`Server is running on http://localhost:\${PORT}\`);
});

module.exports = app;`;

  const envExample = `# Environment Variables
PORT=3000
NODE_ENV=development
`;

  const gitignore = `node_modules/
.env
.DS_Store
*.log
dist/
coverage/
`;

  await fs.writeFile(path.join(projectPath, 'package.json'), JSON.stringify(packageJson, null, 2));
  await fs.writeFile(path.join(projectPath, 'index.js'), indexJs);
  await fs.writeFile(path.join(projectPath, '.env.example'), envExample);
  await fs.writeFile(path.join(projectPath, '.gitignore'), gitignore);
  await fs.writeFile(path.join(projectPath, 'README.md'), `# ${name}\n\n${description}\n\n## Installation\n\n\`\`\`bash\nnpm install\n\`\`\`\n\n## Usage\n\n\`\`\`bash\nnpm start\n\`\`\``);
  
  await fs.mkdir(path.join(projectPath, 'public'), { recursive: true });
  await fs.mkdir(path.join(projectPath, 'routes'), { recursive: true });
  await fs.mkdir(path.join(projectPath, 'models'), { recursive: true });
  await fs.mkdir(path.join(projectPath, 'controllers'), { recursive: true });
}

async function createReactProject(projectPath, name, description) {
  const packageJson = {
    name: name.toLowerCase().replace(/\s+/g, '-'),
    version: "0.1.0",
    private: true,
    description: description,
    dependencies: {
      "react": "^18.2.0",
      "react-dom": "^18.2.0",
      "react-scripts": "5.0.1"
    },
    scripts: {
      "start": "react-scripts start",
      "build": "react-scripts build",
      "test": "react-scripts test",
      "eject": "react-scripts eject"
    },
    "eslintConfig": {
      "extends": ["react-app"]
    },
    "browserslist": {
      "production": [">0.2%", "not dead", "not op_mini all"],
      "development": ["last 1 chrome version", "last 1 firefox version", "last 1 safari version"]
    }
  };
  
  await fs.writeFile(path.join(projectPath, 'package.json'), JSON.stringify(packageJson, null, 2));
  await fs.writeFile(path.join(projectPath, '.gitignore'), 'node_modules/\n.DS_Store\nbuild/\n.env.local\n');
  await fs.writeFile(path.join(projectPath, 'README.md'), `# ${name}\n\n${description}\n\n## Available Scripts\n\n### \`npm start\`\n\nRuns the app in development mode.\n\n### \`npm run build\`\n\nBuilds the app for production.`);
  
  // Create src directory and basic files
  const srcPath = path.join(projectPath, 'src');
  await fs.mkdir(srcPath, { recursive: true });
  
  const appJs = `import React from 'react';
import './App.css';

function App() {
  return (
    <div className="App">
      <header className="App-header">
        <h1>${name}</h1>
        <p>${description}</p>
        <button className="App-button">Get Started</button>
      </header>
    </div>
  );
}

export default App;`;
  
  const indexJs = `import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);`;
  
  const appCss = `.App {
  text-align: center;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
}

.App-header {
  color: white;
}

.App-header h1 {
  font-size: 3rem;
  margin-bottom: 1rem;
}

.App-button {
  background: white;
  color: #667eea;
  border: none;
  padding: 1rem 2rem;
  font-size: 1.1rem;
  border-radius: 50px;
  cursor: pointer;
  transition: transform 0.3s;
  margin-top: 2rem;
}

.App-button:hover {
  transform: translateY(-2px);
}`;
  
  const indexCss = `body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen',
    'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue',
    sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

code {
  font-family: source-code-pro, Menlo, Monaco, Consolas, 'Courier New',
    monospace;
}`;
  
  await fs.writeFile(path.join(srcPath, 'App.js'), appJs);
  await fs.writeFile(path.join(srcPath, 'index.js'), indexJs);
  await fs.writeFile(path.join(srcPath, 'App.css'), appCss);
  await fs.writeFile(path.join(srcPath, 'index.css'), indexCss);
  
  // Create public directory
  const publicPath = path.join(projectPath, 'public');
  await fs.mkdir(publicPath, { recursive: true });
  
  const indexHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#000000" />
    <meta name="description" content="${description}" />
    <title>${name}</title>
  </head>
  <body>
    <noscript>You need to enable JavaScript to run this app.</noscript>
    <div id="root"></div>
  </body>
</html>`;
  
  await fs.writeFile(path.join(publicPath, 'index.html'), indexHtml);
}

async function createVueProject(projectPath, name, description) {
  const packageJson = {
    name: name.toLowerCase().replace(/\s+/g, '-'),
    version: "0.1.0",
    private: true,
    description: description,
    scripts: {
      serve: "vue-cli-service serve",
      build: "vue-cli-service build"
    },
    dependencies: {
      "vue": "^3.2.0",
      "vue-router": "^4.0.0",
      "vuex": "^4.0.0"
    },
    devDependencies: {
      "@vue/cli-service": "^5.0.0"
    }
  };
  
  await fs.writeFile(path.join(projectPath, 'package.json'), JSON.stringify(packageJson, null, 2));
  await fs.writeFile(path.join(projectPath, '.gitignore'), 'node_modules/\n.DS_Store\ndist/\n*.log');
  await fs.writeFile(path.join(projectPath, 'README.md'), `# ${name}\n\n${description}\n\n## Project setup\n\`\`\`\nnpm install\n\`\`\`\n\n### Compiles and hot-reloads for development\n\`\`\`\nnpm run serve\n\`\`\``);
  
  // Create src directory
  const srcPath = path.join(projectPath, 'src');
  await fs.mkdir(srcPath, { recursive: true });
  
  const mainJs = `import { createApp } from 'vue'
import App from './App.vue'

createApp(App).mount('#app')`;
  
  const appVue = `<template>
  <div id="app">
    <header>
      <h1>{{ title }}</h1>
      <p>{{ description }}</p>
      <button @click="handleClick">Get Started</button>
    </header>
  </div>
</template>

<script>
export default {
  name: 'App',
  data() {
    return {
      title: '${name}',
      description: '${description}'
    }
  },
  methods: {
    handleClick() {
      alert('Welcome to ${name}!');
    }
  }
}
</script>

<style>
#app {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  text-align: center;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
}

header h1 {
  font-size: 3rem;
  margin-bottom: 1rem;
}

button {
  background: white;
  color: #667eea;
  border: none;
  padding: 1rem 2rem;
  font-size: 1.1rem;
  border-radius: 50px;
  cursor: pointer;
  transition: transform 0.3s;
  margin-top: 2rem;
}

button:hover {
  transform: translateY(-2px);
}
</style>`;
  
  await fs.writeFile(path.join(srcPath, 'main.js'), mainJs);
  await fs.writeFile(path.join(srcPath, 'App.vue'), appVue);
  
  // Create public directory
  const publicPath = path.join(projectPath, 'public');
  await fs.mkdir(publicPath, { recursive: true });
  
  const indexHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1.0">
    <title>${name}</title>
  </head>
  <body>
    <div id="app"></div>
  </body>
</html>`;
  
  await fs.writeFile(path.join(publicPath, 'index.html'), indexHtml);
}

async function createCppProject(projectPath, name, description) {
  const mainCpp = `#include <iostream>
#include <string>

// ${name}
// ${description}

int main() {
    std::cout << "Welcome to ${name}" << std::endl;
    std::cout << "${description}" << std::endl;
    
    std::cout << "\\nPress Enter to continue...";
    std::cin.get();
    
    return 0;
}`;

  const cmakeLists = `cmake_minimum_required(VERSION 3.10)
project(${name.replace(/\s+/g, '_')})

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Add source files
add_executable(\${PROJECT_NAME} src/main.cpp)

# Include directories
target_include_directories(\${PROJECT_NAME} PUBLIC include)`;

  const buildScript = `#!/bin/bash
# Build script for ${name}

mkdir -p build
cd build
cmake ..
make
echo "Build complete. Executable: ./build/${name.replace(/\s+/g, '_')}"`;

  const buildBat = `@echo off
REM Build script for ${name}

if not exist build mkdir build
cd build
cmake -G "MinGW Makefiles" ..
mingw32-make
echo Build complete. Executable: build\\${name.replace(/\s+/g, '_')}.exe
pause`;

  await fs.mkdir(path.join(projectPath, 'src'), { recursive: true });
  await fs.mkdir(path.join(projectPath, 'include'), { recursive: true });
  await fs.mkdir(path.join(projectPath, 'tests'), { recursive: true });
  
  await fs.writeFile(path.join(projectPath, 'src', 'main.cpp'), mainCpp);
  await fs.writeFile(path.join(projectPath, 'CMakeLists.txt'), cmakeLists);
  await fs.writeFile(path.join(projectPath, 'build.sh'), buildScript);
  await fs.writeFile(path.join(projectPath, 'build.bat'), buildBat);
  await fs.writeFile(path.join(projectPath, '.gitignore'), 'build/\n*.exe\n*.o\n*.out');
  await fs.writeFile(path.join(projectPath, 'README.md'), `# ${name}\n\n${description}\n\n## Building\n\n### Linux/Mac\n\`\`\`bash\n./build.sh\n\`\`\`\n\n### Windows\n\`\`\`cmd\nbuild.bat\n\`\`\``);
}

async function createJavaProject(projectPath, name, description) {
  const className = name.replace(/[^a-zA-Z0-9]/g, '');
  const packageName = `com.${className.toLowerCase()}`;
  
  const mainJava = `package ${packageName};

/**
 * ${name}
 * ${description}
 */
public class Main {
    public static void main(String[] args) {
        System.out.println("Welcome to ${name}");
        System.out.println("${description}");
        
        // Your code here
        Application app = new Application();
        app.run();
    }
}`;

  const appJava = `package ${packageName};

public class Application {
    public void run() {
        System.out.println("Application is running...");
    }
}`;

  const pomXml = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 
         http://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <groupId>${packageName}</groupId>
    <artifactId>${className.toLowerCase()}</artifactId>
    <version>1.0-SNAPSHOT</version>

    <properties>
        <maven.compiler.source>11</maven.compiler.source>
        <maven.compiler.target>11</maven.compiler.target>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    </properties>

    <dependencies>
        <dependency>
            <groupId>junit</groupId>
            <artifactId>junit</artifactId>
            <version>4.13.2</version>
            <scope>test</scope>
        </dependency>
    </dependencies>
</project>`;

  const srcPath = path.join(projectPath, 'src', 'main', 'java', ...packageName.split('.'));
  const testPath = path.join(projectPath, 'src', 'test', 'java', ...packageName.split('.'));
  
  await fs.mkdir(srcPath, { recursive: true });
  await fs.mkdir(testPath, { recursive: true });
  
  await fs.writeFile(path.join(srcPath, 'Main.java'), mainJava);
  await fs.writeFile(path.join(srcPath, 'Application.java'), appJava);
  await fs.writeFile(path.join(projectPath, 'pom.xml'), pomXml);
  await fs.writeFile(path.join(projectPath, '.gitignore'), 'target/\n*.class\n.idea/\n*.iml');
  await fs.writeFile(path.join(projectPath, 'README.md'), `# ${name}\n\n${description}\n\n## Build and Run\n\n\`\`\`bash\nmvn clean compile\nmvn exec:java -Dexec.mainClass="${packageName}.Main"\n\`\`\``);
}

async function createEmptyProject(projectPath, name, description) {
  const readme = `# ${name}\n\n${description}\n\n## Getting Started\n\nThis is an empty project. Add your files here to get started.`;

  await fs.writeFile(path.join(projectPath, 'README.md'), readme);
  await fs.writeFile(path.join(projectPath, '.gitignore'), '.DS_Store\n*.log\nnode_modules/');
}


module.exports = {
  createElectronProject,
  createPythonProject,
  createWebProject,
  createNodeProject,
  createReactProject,
  createVueProject,
  createCppProject,
  createJavaProject,
  createEmptyProject
};
