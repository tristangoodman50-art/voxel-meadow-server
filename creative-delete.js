/**
 * Voxel Meadow Creative Delete Button Module
 * Save this file as 'creative-delete.js' in your project directory
 * and link it in your HTML using: <script src="creative-delete.js"></script>
 */

(function() {
    // 1. Inject the necessary structural CSS styles into the document head
    const style = document.createElement('style');
    style.textContent = `
        .creative-menu-wrapper {
            display: flex !important;
            align-items: flex-start !important;
            gap: 15px !important;
            position: relative !important;
        }

        .creative-delete-container {
            display: flex !important;
            flex-direction: column !important;
            align-items: center !important;
            justify-content: center !important;
            width: 54px !important;
            height: 54px !important;
            background: #8b8b8b !important;
            border: 3px solid #373737 !important;
            border-top-color: #ffffff !important;
            border-left-color: #ffffff !important;
            box-shadow: inset 2px 2px 0px #555 !important;
            cursor: pointer !important;
            user-select: none !important;
            box-sizing: border-box !important;
            transition: background 0.15s ease, border-color 0.15s ease;
        }

        .creative-delete-container:hover {
            background: #bc5454 !important;
            border-color: #5a1a1a !important;
        }

        .creative-delete-container:active {
            border-top-color: #373737 !important;
            border-left-color: #373737 !important;
            border-bottom-color: #ffffff !important;
            border-right-color: #ffffff !important;
            box-shadow: inset -2px -2px 0px #555 !important;
        }

        .creative-delete-icon {
            font-size: 24px !important;
            pointer-events: none !important;
            line-height: 1 !important;
        }

        .creative-delete-label {
            font-size: 9px !important;
            font-weight: bold !important;
            color: #111 !important;
            margin-top: 2px !important;
            text-transform: uppercase !important;
            pointer-events: none !important;
            font-family: monospace, sans-serif !important;
        }
    `;
    document.head.appendChild(style);

    // 2. Main injection function to safe-hook into the creative UI layout
    function injectDeleteButton() {
        // Look for the primary "Creative items" heading or block list container
        const headers = Array.from(document.querySelectorAll('h3, h2, div'));
        let creativeHeader = headers.find(el => el.textContent.trim().toLowerCase() === 'creative items');
        
        if (!creativeHeader) return false;

        // Traverse to find the adjacent block grid elements container
        let gridContainer = creativeHeader.nextElementSibling;
        while (gridContainer && !gridContainer.style.display.includes('grid') && gridContainer.tagName !== 'DIV') {
            gridContainer = gridContainer.nextElementSibling;
        }

        if (!gridContainer || document.getElementById('creative-delete-slot')) return false;

        // Wrap the existing layout structures into a flex row system wrapper
        const parent = gridContainer.parentNode;
        const wrapper = document.createElement('div');
        wrapper.className = 'creative-menu-wrapper';
        
        parent.insertBefore(wrapper, gridContainer);
        wrapper.appendChild(gridContainer);

        // Build out the specific delete button HTML element layout structural object
        const deleteBtn = document.createElement('div');
        deleteBtn.id = 'creative-delete-slot';
        deleteBtn.className = 'creative-delete-container';
        deleteBtn.setAttribute('title', 'Click here while holding a block, or drag an item here to safely clear it.');

        const icon = document.createElement('span');
        icon.className = 'creative-delete-icon';
        icon.innerHTML = '🗑️';

        const label = document.createElement('span');
        label.className = 'creative-delete-label';
        label.innerText = 'Delete';

        deleteBtn.appendChild(icon);
        deleteBtn.appendChild(label);
        wrapper.appendChild(deleteBtn);

        // 3. Interactivity execution handler
        deleteBtn.addEventListener('click', () => {
            let itemCleared = false;

            // Handle common global tracking pattern frameworks across Voxel sandboxes
            if (window.heldItem) {
                window.heldItem = null;
                itemCleared = true;
            }
            
            if (typeof game !== 'undefined' && game.inventory) {
                if (typeof game.inventory.clearHeldItem === 'function') {
                    game.inventory.clearHeldItem();
                    itemCleared = true;
                } else if (game.inventory.heldItem) {
                    game.inventory.heldItem = null;
                    itemCleared = true;
                }
            }

            if (itemCleared) {
                console.log("Voxel Meadow: Item successfully cleared from slot registry.");
                // Try to evoke reactive layout re-renders if methods are available
                if (typeof updateInventoryUI === 'function') updateInventoryUI();
                if (typeof renderInventory === 'function') renderInventory();
                if (typeof refreshHotbar === 'function') refreshHotbar();
            }
        });

        return true;
    }

    // Run the injection logic securely across structural parsing phase checks
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectDeleteButton);
    } else {
        injectDeleteButton();
    }

    // Fallback loop observer to track dynamic menu layout render instantiations
    const observer = new MutationObserver((mutations) => {
        injectDeleteButton();
    });
    observer.observe(document.body, { childList: true, subtree: true });

})();