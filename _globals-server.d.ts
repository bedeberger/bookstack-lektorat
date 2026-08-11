// Typnamen, die in JSDoc-Annotationen des Serverteils vorkommen, ohne dass es im
// ungetypten Projekt eine Deklaration dazu gibt. Sie stehen ausschliesslich in
// Kommentaren und haben keine Runtime-Bedeutung — hier deklariert, damit das
// Import-Gate (scripts/check-imports.js) nicht auf Kommentare anspringt und
// dadurch unglaubwuerdig wird.
//
// KEIN Ablageort fuer fehlende Imports: ein Symbol, das der Code AUFRUFT, gehoert
// importiert, nicht hierher.
declare type Block = any;
declare type PDFDocument = any;
