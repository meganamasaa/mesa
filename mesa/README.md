# 🪑 Mesa - Bill Splitting App

Mesa is a modern, feature-rich bill splitting application built with React, TypeScript, and Vite. It helps groups of people easily split restaurant bills, shared expenses, and other costs with precision and fairness.

## ✨ Features

### Core Functionality
- **People Management**: Add and remove people from your bill
- **Item Tracking**: Add items with names, prices, and quantities
- **Smart Assignment**: Assign items to specific people with checkbox interface
- **Flexible Splitting**: Items are split equally among assigned people
- **Tax & Tip Handling**: Add tax and tip with configurable split modes

### Advanced Features
- **Multi-Currency Support**: Supports EUR, USD, GBP, and MXN
- **Live Exchange Rates**: Real-time USD conversion using open.er-api.com
- **Split Modes**: 
  - **Equal**: Tax and tip split equally among all people
  - **Proportional**: Tax and tip split based on each person's food total
- **Precision Math**: All calculations done in cents to avoid floating-point errors
- **Validation**: Real-time validation of item allocations
- **Copy Summary**: One-click copy of the final bill breakdown

### User Experience
- **Responsive Design**: Works on desktop and mobile devices
- **Undo Functionality**: Undo item deletions
- **Keyboard Shortcuts**: Press Enter to add items, Escape to clear forms
- **Visual Feedback**: Clear indicators for unallocated items and validation status

## 🚀 Getting Started

### Prerequisites
- Node.js 18 or higher
- npm or yarn

### Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd mesa
```

2. Install dependencies:
```bash
npm install
```

3. Start the development server:
```bash
npm run dev
```

4. Open your browser and navigate to `http://localhost:5173`

### Building for Production

```bash
npm run build
```

The built files will be in the `dist` directory.

## 🏗️ Project Structure

```
mesa/
├── src/
│   ├── App.tsx          # Main application component
│   ├── styles.css       # Application styles
│   └── main.tsx         # Application entry point
├── api/
│   └── parse-receipt-openai.ts  # Receipt parsing API (Vercel)
├── public/              # Static assets
├── dist/               # Built application
└── package.json        # Dependencies and scripts
```

## 🔧 API Endpoints

### Receipt Parsing (Vercel API)
- **Endpoint**: `/api/parse-receipt-openai`
- **Method**: POST
- **Content-Type**: multipart/form-data
- **Description**: Upload receipt images for parsing (currently returns metadata)

## 💡 Usage Guide

### Adding People
1. Enter a name in the "Add a name" field
2. Click "Add" or press Enter
3. Remove people by clicking "remove" next to their name

### Adding Items
1. Fill in the item name, price, and quantity
2. Click "+ Add" or press Enter
3. Edit items directly in the list
4. Remove items with the 🗑️ button (undo available)

### Assigning Items
1. Use the assignment table to check who shared each item
2. Use "All" and "None" buttons for quick assignment
3. Items with no assignments will show a warning

### Bill Settings
1. Select your currency (EUR, USD, GBP, MXN)
2. Add tax and tip amounts
3. Choose split mode:
   - **Equal**: Everyone pays the same amount for tax/tip
   - **Proportional**: Tax/tip split based on food consumption

### Settlement
- View each person's total amount owed
- USD equivalents shown for non-USD currencies
- Copy the complete summary to share with your group

## 🛠️ Technical Details

### Built With
- **React 19** - UI framework
- **TypeScript** - Type safety
- **Vite** - Build tool and dev server
- **Vercel** - API hosting
- **Formidable** - File upload handling

### Key Technical Features
- **Cent-based Math**: All monetary calculations use integer cents to prevent floating-point errors
- **Live Exchange Rates**: Hourly updates from open.er-api.com
- **Responsive Design**: Mobile-first CSS with grid layouts
- **Type Safety**: Full TypeScript coverage with strict typing

### Development
- **ESLint**: Code linting with React-specific rules
- **Hot Module Replacement**: Fast development with Vite
- **TypeScript**: Strict type checking enabled

## 🔮 Future Enhancements

- **Receipt OCR**: Complete the receipt parsing functionality with OpenAI Vision
- **Save/Load Bills**: Persist bills for later reference
- **Payment Integration**: Connect with payment apps
- **Group Management**: Save and reuse groups of people
- **Export Options**: PDF receipts, CSV exports

## 📝 License

This project is open source and available under the MIT License.


