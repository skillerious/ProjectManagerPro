/* Runtime module: projects/30-tips-and-scroll-effects.js */
function createTipsPages() {
    tipsPages = [];
    const tipsCopy = [...tipsDatabase];

    // Shuffle tips
    for (let i = tipsCopy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [tipsCopy[i], tipsCopy[j]] = [tipsCopy[j], tipsCopy[i]];
    }

    // Group into pages of 3
    for (let i = 0; i < tipsCopy.length; i += 3) {
        tipsPages.push(tipsCopy.slice(i, i + 3));
    }
}

function renderNavigationDots() {
    const navContainer = document.getElementById('tips-navigation');
    if (!navContainer || tipsPages.length === 0) return;

    // Check if dots already exist
    const existingDots = navContainer.querySelectorAll('.tip-dot');

    if (existingDots.length === 0) {
        // Initial render
        navContainer.innerHTML = tipsPages.map((_, index) => `
            <button class="tip-dot ${index === currentTipsPage ? 'active' : ''}"
                    data-page="${index}"
                    aria-label="View tips page ${index + 1}"></button>
        `).join('');

        // Add click handlers
        navContainer.querySelectorAll('.tip-dot').forEach(dot => {
            dot.addEventListener('click', () => {
                const page = parseInt(dot.getAttribute('data-page'));
                goToTipsPage(page);
            });
        });
    } else {
        // Update existing dots with smooth transition
        const previousActiveDot = navContainer.querySelector('.tip-dot.active');

        existingDots.forEach((dot, index) => {
            if (index === currentTipsPage) {
                // Add morphing class for smooth transition
                if (previousActiveDot && previousActiveDot !== dot) {
                    dot.classList.add('morphing-in');
                    previousActiveDot.classList.add('morphing-out');

                    // Clean up morphing classes after transition
                    setTimeout(() => {
                        dot.classList.remove('morphing-in');
                        if (previousActiveDot) {
                            previousActiveDot.classList.remove('morphing-out');
                        }
                    }, 600);
                }
                dot.classList.add('active');
            } else {
                dot.classList.remove('active', 'animating');
            }
        });
    }

    // Start progress animation on active dot
    setTimeout(() => {
        const activeDot = navContainer.querySelector('.tip-dot.active');
        if (activeDot) {
            // Force animation restart by removing and re-adding class
            activeDot.classList.remove('animating');
            void activeDot.offsetWidth; // Trigger reflow
            activeDot.classList.add('animating');
        }
    }, 50);
}

function renderTips(withAnimation = true) {
    const tipsContainer = document.getElementById('tips-container');
    if (!tipsContainer || tipsPages.length === 0) return;

    const tipsToShow = tipsPages[currentTipsPage];

    if (withAnimation) {
        // Animate out
        tipsContainer.classList.add('animating-out');

        setTimeout(() => {
            // Update content
            tipsContainer.innerHTML = tipsToShow.map(tip => `
                <div class="tip-card">
                    <div class="tip-icon">
                        <i class="${tip.icon}"></i>
                    </div>
                    <h4>${tip.title}</h4>
                    <p>${tip.description}</p>
                </div>
            `).join('');

            // Animate in
            tipsContainer.classList.remove('animating-out');
            tipsContainer.classList.add('animating-in');

            setTimeout(() => {
                tipsContainer.classList.remove('animating-in');
            }, 600);
        }, 300);
    } else {
        // No animation, just render
        tipsContainer.innerHTML = tipsToShow.map(tip => `
            <div class="tip-card">
                <div class="tip-icon">
                    <i class="${tip.icon}"></i>
                </div>
                <h4>${tip.title}</h4>
                <p>${tip.description}</p>
            </div>
        `).join('');
    }

    // Update navigation dots
    renderNavigationDots();
}

function goToTipsPage(pageIndex) {
    if (pageIndex < 0 || pageIndex >= tipsPages.length) return;

    currentTipsPage = pageIndex;
    renderTips(true);

    // Reset auto-rotation timer
    if (tipsRotationInterval) {
        clearInterval(tipsRotationInterval);
        startAutoRotation();
    }
}

function nextTipsPage() {
    currentTipsPage = (currentTipsPage + 1) % tipsPages.length;
    renderTips(true);
}

function startAutoRotation() {
    tipsRotationInterval = setInterval(() => {
        nextTipsPage();
    }, 30000); // 30 seconds
}

function startTipsRotation() {
    // Create pages
    createTipsPages();

    if (tipsPages.length === 0) return;

    // Render initial tips without animation
    currentTipsPage = 0;
    renderTips(false);

    // Start auto-rotation
    if (tipsRotationInterval) {
        clearInterval(tipsRotationInterval);
    }
    startAutoRotation();
}

// ============================================
// PREMIUM SCROLL EFFECTS
// ============================================

function initializePremiumScrollEffects() {
    // All scroll effects removed for basic scrolling experience
}

// Initialize tips after a short delay
setTimeout(() => {
    startTipsRotation();
}, 1000);








async function refreshStatusBranch() {
    if (!isProUnlocked()) {
        setStatusGitBranch('--');
        return;
    }

    if (!currentProject || !currentProject.path) {
        setStatusGitBranch('--');
        return;
    }

    const hasGitRepository = currentProject.hasGit === true || await isGitRepositoryPath(currentProject.path);
    currentProject.hasGit = hasGitRepository;
    if (!hasGitRepository) {
        setStatusGitBranch('--');
        return;
    }

    try {
        const result = await ipcRenderer.invoke('git-branches', currentProject.path);
        if (!result.success || !result.output) {
            setStatusGitBranch('--');
            return;
        }

        const activeBranch = result.output
            .split('\n')
            .map((branch) => branch.trim())
            .find((branch) => branch.startsWith('*'));

        if (!activeBranch) {
            setStatusGitBranch('main');
            return;
        }

        const activeName = activeBranch.replace('*', '').trim();
        setStatusGitBranch(activeName || 'main');
    } catch {
        setStatusGitBranch('--');
    }
}

