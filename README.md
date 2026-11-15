# Ledapla

Een lesplanner voor een leerkracht met drie niveaugroepen (Verrijkt, Basis, Intensief).
Open `index.html` in een browser; er is geen server of build nodig. Alle gegevens staan in de browser (localStorage).

## Wat het doet
- **Rooster**: een klikbaar weekrooster met blokken (vak + tijden). Je maakt één keer een **sjabloon** (je standaardweek). Daarna pas je ofwel het sjabloon aan, ofwel één **specifieke week** (die krijgt dan een eigen rooster; "Terug naar sjabloon" maakt dat ongedaan). Klik op een lege plek om een blok toe te voegen (optioneel meteen op meerdere dagen), klik op een blok om het te bewerken of te verwijderen.
- **Vakken & methodes**: per vak naam, kleur, de lessen van de methode in volgorde (`code | titel | omschrijving`, optioneel per groep) en een terugvalmethode.
- **Vandaag** (startpagina): het weekrooster met de verwachte lessen ingevuld, en daaronder per blok drie kolommen (Verrijkt / Basis / Intensief) met de les van die groep. Per blok kies je *Gelukt* of *Niet gelukt*.
- **Dag afsluiten**: gelukt gaat automatisch door naar de volgende les van de methode; niet gelukt blijft staan en wordt gemarkeerd als "opnieuw aanbieden" met de terugvalmethode. De voortgang loopt per groep. De verwachte lessen in de rest van de week gaan ervan uit dat elke les lukt.
- **AI-hulp**: chat met Claude, die de planning van de dag kent. Vul een Anthropic API-sleutel in bij Instellingen.
- Back-up via exporteren/importeren (JSON). Oude gegevens met vaste dagen per vak worden automatisch omgezet naar een sjabloon.
