# TomTom Travel Time

Connecteur non officiel, sans lien avec TomTom. Pour chaque trajet que vous
saisissez, Gladys reçoit la durée avec le trafic en temps réel, le retard dû
au trafic, la distance et la durée sans trafic, lus par l'API officielle
**TomTom Routing** (Calculate Route) avec une clé gratuite.

> Cette intégration n'a **jamais été testée avec une vraie clé TomTom** : elle
> suit la documentation officielle de TomTom et ses tests simulent les
> réponses de l'API. Vos retours sont les bienvenus.

Elle remplace l'idée d'une intégration Waze : l'API de Waze n'est accessible
qu'en contournant sa protection anti-robots. Une intégration **Mapbox Traffic**
de qleg existe déjà et fait la même chose avec Mapbox (fil n° 11024 du forum :
https://community.gladysassistant.com/t/11024) : choisissez celle dont le
fournisseur vous convient.

L'ergonomie (un trajet avec un nom, une origine et une destination, relevé
périodiquement) s'inspire de l'intégration « Waze Travel Time » de Home
Assistant (Apache-2.0). Aucun code n'en est repris.

## Créer la clé gratuite

1. Créez un compte sur https://developer.tomtom.com/user/register (aucune
   carte bancaire demandée) et confirmez l'adresse e-mail.
2. Connectez-vous à https://developer.tomtom.com, ouvrez votre tableau de bord,
   puis **Keys** (Clés).
3. Une première clé est créée avec le compte et donne accès aux API, Routing
   comprise. Copiez-la (ou créez-en une nouvelle et cochez **Routing API**).
4. Collez-la dans le champ **Clé d'API TomTom** de l'intégration.

L'offre gratuite permet **2 500 requêtes par jour**. La clé est gardée par
Gladys dans sa base, jamais réaffichée, et envoyée seulement à
`api.tomtom.com`. Elle n'apparaît ni dans les journaux, ni dans les messages,
ni dans les statuts.

## Saisir les trajets

Champ **Trajets** : un trajet par entrée, séparés par `;`. Chaque trajet est
un nom, l'origine et la destination en `latitude,longitude` (point décimal),
séparés par `|` :

```
Travail | 48.85661,2.35222 | 48.89198,2.23881; École | 48.80000,2.30000 | 48.81000,2.31000
```

- Pour trouver des coordonnées : clic droit sur un point dans Google Maps ou
  OpenStreetMap, puis copier les deux nombres.
- Vingt trajets au maximum ; deux trajets ne peuvent pas avoir le même nom.
- Un trajet invalide est ignoré et nommé dans le statut (jamais ses
  coordonnées).
- Le nom identifie l'appareil : renommer un trajet crée un nouvel appareil
  (l'ancien garde son historique). Changer ses coordonnées garde l'appareil.
- Les adresses ne sont pas prises en charge pour l'instant (pas d'appel à
  l'API Search de TomTom) : donnez des coordonnées.

Options communes à tous les trajets :

- **Véhicule** : voiture, ou camion (routes et vitesses d'un camion, sans ses
  dimensions ni son poids).
- **Éviter les péages**, **Éviter les autoroutes**.
- Le départ est toujours **maintenant**, avec le trafic en temps réel.

## Les appareils

Après l'enregistrement, chaque trajet apparaît dans l'onglet **Découverte**.
Ajoutez-le pour obtenir :

| Fonction            | Catégorie Gladys  | Unité   |
| ------------------- | ----------------- | ------- |
| Durée avec trafic   | `duration`        | minutes |
| Retard dû au trafic | `duration`        | minutes |
| Distance            | `distance-sensor` | km      |
| Durée sans trafic   | `duration`        | minutes |

Les valeurs sont arrondies au dixième. La durée sans trafic est celle que
TomTom calcule sans aucun trafic (`noTrafficTravelTimeInSeconds`).

## Le quota et la fréquence

Chaque relevé d'un trajet coûte une requête. **Requêtes par jour = trajets ×
(minutes de la plage de relevé ÷ intervalle)**.

| Intervalle      | Requêtes par trajet et par jour (toute la journée) | Trajets possibles |
| --------------- | -------------------------------------------------- | ----------------- |
| 5 min (minimum) | 288                                                | 8                 |
| 10 min (défaut) | 144                                                | 17                |
| 15 min          | 96                                                 | 20                |

- Le statut de l'intégration affiche le nombre de requêtes par jour prévu
  après chaque enregistrement.
- Une configuration qui prévoit **plus de 2 500 requêtes par jour est
  refusée** : rien n'est lu et le statut dit quoi changer.
- L'intégration compte elle-même ses requêtes par jour UTC et n'en envoie
  jamais plus de 2 500, relevés de scène et bouton de test compris. Le compte
  survit à un redémarrage (fichier dans `/data`).
- Un trajet n'est jamais relu plus vite que l'intervalle, même après une
  erreur ou un redémarrage.
- Une réponse 429 de TomTom suspend toutes les requêtes (Retry-After, sinon
  1 minute doublée à chaque fois, entre 1 minute et 6 heures). Un 403 pour le
  quota du jour les suspend jusqu'au prochain minuit UTC (au moins 1 heure).
  Une clé refusée arrête les relevés, avec un nouvel essai toutes les
  6 heures jusqu'à ce que la clé change. Ces pauses survivent à un
  redémarrage.

## Plage de relevé (facultatif)

Pour économiser le quota, relevez les trajets seulement entre deux heures,
par exemple de 6 h à 20 h (14 heures : 84 requêtes par trajet à 10 minutes).
De 0 à 24 relève toute la journée ; une plage peut passer minuit (de 22 à 6).
Les heures sont celles du **fuseau horaire** indiqué (celui de votre Gladys,
`Europe/Paris` par défaut). Hors de la plage, les dernières valeurs restent
affichées et ne sont plus renvoyées.

## Scène : rafraîchir un trajet maintenant

L'action de scène **Rafraîchir un trajet TomTom maintenant** relève le trajet
choisi tout de suite, sauf s'il l'a été il y a moins de **2 minutes** (une
scène en boucle ne peut pas épuiser le quota) : elle rend alors ses dernières
valeurs. Elle fonctionne aussi hors de la plage de relevé. Sorties, utilisables
par les actions suivantes : `refreshed` (relevé maintenant ou non),
`travel_time_minutes`, `traffic_delay_minutes`, `distance_km`,
`no_traffic_time_minutes`. Le relevé suivant vient un intervalle entier plus
tard.

Exemple : chaque matin de semaine à 7 h 30, rafraîchir « Travail », puis
envoyer un message si `traffic_delay_minutes` dépasse 10.

## Bouton « Tester TomTom »

Relève le premier trajet (une requête, au plus une fois toutes les
2 minutes), puis affiche le nombre de requêtes prévu, celles utilisées
aujourd'hui, et les dernières valeurs de chaque trajet.

## Confidentialité

Les coordonnées de vos trajets (souvent votre domicile) et la clé sont
envoyées à TomTom (`api.tomtom.com`) à chaque relevé, et à personne d'autre.
Le fichier `/data/tomtom-state.json` garde le compte du jour, les pauses, une
empreinte de la clé (jamais la clé) et l'heure du dernier relevé de chaque
trajet.

## Dépannage

- **« TomTom a refusé la clé »** : vérifiez la clé sur developer.tomtom.com
  et qu'elle a accès à la Routing API.
- **« aucun itinéraire entre les points »** : un point est loin de toute
  route, ou les points ne sont pas reliés par la route ; réessayé toutes les
  heures au plus.
- **Configuration refusée** : augmentez l'intervalle, réduisez la plage
  horaire ou retirez des trajets.
- Journaux de l'intégration : depuis l'interface de Gladys.

## Licence

Apache-2.0. TomTom est une marque de TomTom N.V. ; ce connecteur n'est ni
affilié ni approuvé par TomTom.
