const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function scrapeBourseDirectData() {
  // Lancer un navigateur
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  try {
    const page = await browser.newPage();
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

    const csvFilePath = 'titres_PEA.csv';
    fs.writeFileSync(csvFilePath, 'Nom,ISIN,Type\n');

    await page.goto('https://www.boursedirect.fr/fr/marches/recherche?pea=true', {
      waitUntil: 'networkidle2',
      timeout: 60000 // Augmenter le timeout à 60 secondes
    });
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // D'abord, essayer de changer le nombre de résultats par page à 60
    console.log('Tentative de changement à 60 résultats par page...');
    const display60Success = await page.evaluate(() => {
      // Rechercher le sélecteur pour afficher 60 résultats
      const display60Button = document.querySelector('#display-by-60');
      if (display60Button) {
        display60Button.click();
        return true;
      }
      
      // Rechercher par d'autres sélecteurs possibles
      const alternativeSelectors = [
        '.display-by input[value="60"]',
        'input[name="display-by"][value="60"]',
        '.display-by-60'
      ];
      

      for (const selector of alternativeSelectors) {
        const element = document.querySelector(selector);
        if (element) {
          element.click();
          return true;
        }
      }
      
      return false;
    });
    
    console.log(`Changement à 60 résultats ${display60Success ? 'réussi' : 'échoué'}`);
    
    // Attendre que la page se recharge avec potentiellement 60 résultats
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Stratégie: récupérer les données en parcourant plusieurs pages
    console.log('Démarrage de la récupération des données...');
    
    let totalResults = 0;
    let currentPage = 1;
    
    // Obtenir le nombre total de pages
    const totalPages = await page.evaluate(() => {
      const totalPagesElement = document.querySelector('.pagination-pills .totalPages');
      if (totalPagesElement) {
        const match = totalPagesElement.textContent.match(/\/\s*(\d+)/);
        return match ? parseInt(match[1]) : 1;
      }
      return 1;
    });
    
    console.log(`Nombre total de pages détecté: ${totalPages}`);
    
    // Fonction pour écrire les résultats dans le fichier CSV
    const appendToCSV = (results) => {
      const csvContent = results.map(item => {
        // Préparer le nom en échappant les virgules par des espaces ou autre caractère
        // pour éviter de casser le format CSV sans utiliser de guillemets
        const escapedName = item.name.replace(/,/g, ' ');
        
        // Format CSV sans guillemets autour du nom
        return `${escapedName},${item.isin},${item.type}`;
      }).join('\n');
      
      fs.appendFileSync(csvFilePath, csvContent + '\n');
    };
    
    // Parcourir toutes les pages
    while (currentPage <= totalPages) {
      console.log(`Récupération des données de la page ${currentPage}/${totalPages}...`);
      
      // Extraire les données de la page courante
      const pageResults = await page.evaluate(() => {
        const instruments = [];
        
        // Sélectionner tous les instruments (qui sont probablement des éléments conteneurs)
        document.querySelectorAll('.instrument, .instrument-item, .instrument-container').forEach((instrumentContainer) => {
          // Chercher head-instrument et body-instrument dans ce conteneur
          const headElement = instrumentContainer.querySelector('.head-instrument');
          const bodyElement = instrumentContainer.querySelector('.body-instrument');
          
          if (headElement) {
            const titleElement = headElement.querySelector('span.title-instrument');
            const isinElement = headElement.querySelector('span.isin');
            
            // Chercher typeBadge dans body-instrument
            const typeElement = bodyElement ? bodyElement.querySelector('span.typeBadge') : null;
            
            if (titleElement && isinElement) {
              let nameText = '';
              for (const node of titleElement.childNodes) {
                if (node.nodeType === Node.TEXT_NODE) {
                  nameText += node.textContent.trim();
                }
              }
              
              // Nettoyer le nom en supprimant les guillemets au début et à la fin
              // ainsi que tous les guillemets à l'intérieur
              const cleanName = nameText.trim().replace(/"/g, '');
              
              instruments.push({
                name: cleanName,
                isin: isinElement.textContent.trim(),
                type: typeElement ? typeElement.textContent.trim() : "Non spécifié"
              });
            }
          }
        });
        
        // Si la méthode ci-dessus n'a pas fonctionné, essayer une approche alternative
        if (instruments.length === 0) {
          // Parcourir les éléments .head-instrument et rechercher les .body-instrument correspondants
          document.querySelectorAll('.head-instrument').forEach((headElement, index) => {
            const titleElement = headElement.querySelector('span.title-instrument');
            const isinElement = headElement.querySelector('span.isin');
            
            // Trouver le body-instrument correspondant (peut être le suivant dans le DOM)
            const bodyElements = document.querySelectorAll('.body-instrument');
            const bodyElement = bodyElements[index]; // Supposant qu'ils sont dans le même ordre
            
            const typeElement = bodyElement ? bodyElement.querySelector('span.typeBadge') : null;
            
            if (titleElement && isinElement) {
              let nameText = '';
              for (const node of titleElement.childNodes) {
                if (node.nodeType === Node.TEXT_NODE) {
                  nameText += node.textContent.trim();
                }
              }
              
              // Nettoyer le nom en supprimant tous les guillemets
              const cleanName = nameText.trim().replace(/"/g, '');
              
              instruments.push({
                name: cleanName,
                isin: isinElement.textContent.trim(),
                type: typeElement ? typeElement.textContent.trim() : "Non spécifié"
              });
            }
          });
        }
        
        return instruments;
      });
      
      console.log(`Page ${currentPage}: ${pageResults.length} résultats trouvés`);
      totalResults += pageResults.length;
      
      // Enregistrer les résultats de cette page dans le CSV
      if (pageResults.length > 0) {
        appendToCSV(pageResults);
        console.log(`Données de la page ${currentPage} enregistrées dans ${csvFilePath}`);
      }
      
      // Si nous avons atteint la dernière page, sortir de la boucle
      if (currentPage >= totalPages) {
        break;
      }
      
      // Méthode 1: Utiliser le bouton suivant avec gestion spéciale AJAX
      let navigateSuccess = false;
      
      console.log('Tentative de navigation avec le bouton "Suivant"...');
      navigateSuccess = await page.evaluate(() => {
        const nextButton = document.querySelector('.pagination-pills .fa.fa-angle-right');
        if (nextButton && !nextButton.disabled) {
          // Stocker la valeur actuelle de l'input de pagination
          const currentInputValue = document.querySelector('input[name="pagination-current-page"]')?.value;
          
          // Cliquer sur le bouton
          nextButton.click();
          
          // Indiquer que nous avons cliqué
          return { clicked: true, previousValue: currentInputValue };
        }
        return { clicked: false };
      });
      
      if (navigateSuccess.clicked) {
        console.log('Bouton "Suivant" cliqué, attente du chargement...');
        
        // Attendre que la page change (en surveillant l'input de pagination)
        let pageChanged = false;
        for (let attempt = 0; attempt < 10; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          const newPageValue = await page.evaluate(() => {
            return document.querySelector('input[name="pagination-current-page"]')?.value;
          });
          
          if (newPageValue && newPageValue !== navigateSuccess.previousValue) {
            console.log(`Page changée: ${navigateSuccess.previousValue} -> ${newPageValue}`);
            pageChanged = true;
            break;
          }
          
          console.log(`Attente du changement de page (tentative ${attempt + 1}/10)...`);
        }
        
        if (!pageChanged) {
          console.log('La page n\'a pas changé, essai avec la méthode 2...');
          
          // Méthode 2: Saisir directement le numéro de page
          const nextPage = currentPage + 1;
          console.log(`Tentative d'accès direct à la page ${nextPage}...`);
          
          const directNavSuccess = await page.evaluate(async (nextPage) => {
            const input = document.querySelector('input[name="pagination-current-page"]');
            if (input) {
              // Sauvegarder la valeur actuelle
              const originalValue = input.value;
              
              // Changer la valeur
              input.value = nextPage;
              
              // Déclencher les événements
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
              
              // Simuler l'appui sur Entrée
              input.dispatchEvent(new KeyboardEvent('keydown', { 
                key: 'Enter', 
                code: 'Enter', 
                keyCode: 13, 
                which: 13,
                bubbles: true 
              }));
              
              return { success: true, originalValue };
            }
            return { success: false };
          }, nextPage);
          
          if (directNavSuccess.success) {
            console.log('Accès direct à la page initié, attente du chargement...');
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            // Vérifier si la page a changé
            const pageNum = await page.evaluate(() => {
              return document.querySelector('input[name="pagination-current-page"]')?.value;
            });
            
            if (pageNum == nextPage) {
              console.log(`Page changée avec succès à ${pageNum}`);
            } else {
              console.log(`Échec du changement de page: valeur actuelle = ${pageNum}`);
              break; // Sortir de la boucle si on ne peut pas naviguer
            }
          } else {
            console.log('Impossible de trouver l\'input de pagination, arrêt du scraping');
            break;
          }
        }
      } else {
        console.log('Bouton "Suivant" non trouvé ou désactivé, tentative avec méthode alternative...');
        
        // Méthode alternative: accès direct par l'URL
        const nextPage = currentPage + 1;
        try {
          await page.goto(`https://www.boursedirect.fr/fr/marches/recherche?pea=true&page=${nextPage}`, {
            waitUntil: 'networkidle2',
            timeout: 30000
          });
          console.log(`Navigation par URL vers la page ${nextPage}`);
        } catch (e) {
          console.log(`Erreur lors de la navigation par URL: ${e.message}`);
          break;
        }
      }
      
      // Attendre que le contenu soit chargé
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      currentPage++;
    }
    
    // Rapport final
    console.log(`Scraping terminé! Total des instruments financiers trouvés: ${totalResults}`);
    console.log(`Données enregistrées dans ${csvFilePath}`);
    
    return totalResults;
    
  } catch (error) {
    console.error('Erreur lors du scraping:', error);
    return 0;
  } finally {
    // Fermer le navigateur
    await browser.close();
  }
}

// Exécuter la fonction de scraping
scrapeBourseDirectData();