# Ledapla

Een lesplanner voor een leerkracht met drie niveaugroepen (Verrijkt, Basis, Intensief).
Open `index.html` in een browser; er is geen server of build nodig. Alle gegevens staan in de browser (localStorage).

## Wat het doet
- **Vakken & methodes**: per vak het weekrooster, de lessen van de methode in volgorde (`code | titel | omschrijving`, optioneel per groep), en een terugvalmethode.
- **Vandaag**: per vak drie blokken (Verrijkt / Basis / Intensief) met de les van die groep en een korte omschrijving. Per blok kies je *Gelukt* of *Niet gelukt*.
- **Dag afsluiten**: gelukt gaat automatisch door naar de volgende les van de methode; niet gelukt blijft staan en wordt gemarkeerd als "opnieuw aanbieden" met de terugvalmethode. De voortgang loopt per groep, dus groepen kunnen uit elkaar lopen.
- **Morgen**: voorbeeld van wat er de volgende lesdag klaarstaat.
- **AI-hulp**: chat met Claude, die de planning van de dag kent. Vul een Anthropic API-sleutel in bij Instellingen.
- Back-up via exporteren/importeren (JSON).
